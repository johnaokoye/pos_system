const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { isSerialNumberProduct, serialNumberLabel, serialNumberOf, serialClashError } = require('../lib/serialNumber');
const { createTransfer } = require('../lib/transfers');
const { getOutstandingQty, getOutOfServiceQty } = require('../lib/rentalAvailability');
const { resolveUnit, lineName, parseQty } = require('../lib/units');
const { feeFor, getBranchStock, buildRentalLines, revalidateQuoteLines, insertPendingAgreement, assertRentalCustomerEligible, assertNoUnpaidRentalReturns, rentalQuoteSummary, attachRentalRates, attachRateBasis, rentalWindow, rateLineOf } = require('../lib/rentals');
const { ratePlanError } = require('../lib/rentalPricing');
const { allocateTicketDiscount } = require('../lib/ticketDiscount');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { resolveApprovalSignature } = require('../lib/signatures');

// Special Projects (quote_type='special_project') are gated by their own
// `special_projects`/`special_projects_approve` permissions, deliberately
// independent of `quotations` — "only a few people" per the business
// requirement, not implied by ordinary Quotations access. Either permission
// gets a request into this router; individual routes below enforce the
// specific one they need (creating/editing needs special_projects,
// approving needs special_projects_approve, viewing needs either).
router.use(requireAnyPermission('quotations', 'special_projects'));

// A rental quote's deposit depends on whether the customer is a credit
// customer (see lib/rentals.js's depositWaiver).
async function customerTypeOf(customerId) {
  if (!customerId) return null;
  const { rows: [c] } = await db.execute({ sql: 'SELECT customer_type FROM customers WHERE id = ?', args: [customerId] });
  return c ? c.customer_type : null;
}

// A "Special Order" is a retail quote or Special Project with at least one
// Q item — something not in the catalog that Purchasing has to order (see
// flagItemsForPurchasing below for the same rule: on a retail quote every
// custom line is one, on a Special Project only lines added as Q items are;
// rental quotes never are).
const IS_SPECIAL_ORDER_SQL = `EXISTS (SELECT 1 FROM quotation_items sqi WHERE sqi.quote_id = q.id AND (
    (q.quote_type = 'special_project' AND sqi.is_q_item = 1)
    OR (COALESCE(q.quote_type, 'retail') = 'retail' AND sqi.is_temp_item = 1)))`;

const canSeeSpecialProjects = req => can(req.employee && req.employee.permissions, 'special_projects') || can(req.employee && req.employee.permissions, 'special_projects_approve');

router.get('/', async (req, res) => {
  try {
    const { status, customer_id, quote_number, quote_type, start, end, special_order, limit = 100 } = req.query;
    let sql = `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.customer_type, e.first_name || ' ' || e.last_name as employee_name, oe.first_name || ' ' || oe.last_name as original_employee_name, ae.first_name || ' ' || ae.last_name as approved_by_name, re.first_name || ' ' || re.last_name as rejected_by_name, b.name as branch_name, t.transaction_number as converted_tx_number, ra.agreement_number as converted_agreement_number, ra.status as converted_agreement_status, ${IS_SPECIAL_ORDER_SQL} as is_special_order FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN employees e ON q.employee_id = e.id LEFT JOIN employees oe ON q.original_employee_id = oe.id LEFT JOIN employees ae ON q.approved_by = ae.id LEFT JOIN employees re ON q.rejected_by = re.id LEFT JOIN branches b ON q.branch_id = b.id LEFT JOIN transactions t ON q.converted_to_tx = t.id LEFT JOIN rental_agreements ra ON q.converted_to_agreement_id = ra.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND q.status = ?'; params.push(status); }
    if (quote_type) { sql += ' AND q.quote_type = ?'; params.push(quote_type); }
    if (customer_id) { sql += ' AND q.customer_id = ?'; params.push(customer_id); }
    if (quote_number) { sql += ' AND q.quote_number LIKE ?'; params.push(`%${quote_number}%`); }
    if (start) { sql += ' AND date(q.created_at) >= ?'; params.push(start); }
    if (end) { sql += ' AND date(q.created_at) <= ?'; params.push(end); }
    if (special_order === '1') { sql += ` AND ${IS_SPECIAL_ORDER_SQL}`; }
    // Special Projects stay invisible to anyone without special_projects/
    // special_projects_approve, even in the unfiltered list — "only a few
    // people" means they don't show up at all, not just that they can't be
    // opened. req.apiKey callers (e-commerce integrations) never have an
    // employee/permissions object, so canSeeSpecialProjects is always false
    // for them too — correct, they shouldn't see internal special projects.
    if (!canSeeSpecialProjects(req)) { sql += " AND q.quote_type != 'special_project'"; }
    sql += ' ORDER BY q.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    for (const r of rows) if (r.quote_type === 'rental') r.total = rentalQuoteSummary(r).total;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Inserts a retail/Special Project quote's processed lines (processQuoteItems
// output). Rental lines' accessory children point at their parent row via
// parent_item_id, which needs the real ids — set in a second pass.
async function insertQuoteLines(tx, quoteId, processedItems) {
  for (const item of processedItems) {
    const { product_id, product_name, sku, is_temp_item, is_q_item, purchase_request_id, sources, qty, unit_price, unit_cost, lineTotal, lineTax, lineDisc, serial_number } = item;
    const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,unit_cost,discount_amount,tax_amount,total,is_temp_item,is_q_item,purchase_request_id,serial_number,is_rental_line,rental_start,rental_end,is_mandatory,rate_plan,sell_unit,units_per,uom_id,is_comment,is_delivery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [quoteId, product_id, product_name, sku, qty, unit_price, unit_cost, lineDisc, lineTax, lineTotal, is_temp_item, is_q_item, purchase_request_id, serial_number || null, item.is_rental_line ? 1 : 0, item.rental_start || null, item.rental_end || null, item.is_mandatory ? 1 : 0, item.rate_plan || null, item.sell_unit || null, item.units_per || 1, item.uom_id ?? null, item.is_comment ? 1 : 0, item.is_delivery ? 1 : 0] });
    item.id = Number(itemResult.lastInsertRowid);
    if (sources) {
      for (const src of sources) {
        await tx.execute({ sql: 'INSERT INTO quotation_item_sources (quotation_item_id, branch_id, quantity) VALUES (?,?,?)', args: [item.id, src.branch_id, src.quantity] });
      }
    }
  }
  for (const item of processedItems) {
    if (item.parentIndex != null) await tx.execute({ sql: 'UPDATE quotation_items SET parent_item_id = ? WHERE id = ?', args: [processedItems[item.parentIndex].id, item.id] });
  }
}

const QUOTE_ITEMS_SELECT = `SELECT qi.*, pr.pr_number as purchase_request_number, pr.status as purchase_request_status
  FROM quotation_items qi LEFT JOIN purchase_requests pr ON qi.purchase_request_id = pr.id WHERE qi.quote_id = ?`;

// Attaches each item's branch-sourcing breakdown (`item.sources`) — how much of
// the requested quantity comes from the quote's own branch (no row for that
// portion), a different branch (with the transfer that's moving it, once
// accept-time processing has run), or has no stock anywhere and is on order
// via the quote's Purchase Request. Only items with an actual split have rows.
async function attachQuoteItemSources(items) {
  if (!items.length) return items;
  const ids = items.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const { rows: sources } = await db.execute({
    sql: `SELECT qis.*, b.name as branch_name, bt.transfer_number, bt.status as transfer_status,
            pr.id as purchase_request_id, pr.pr_number as purchase_request_number
          FROM quotation_item_sources qis
          LEFT JOIN branches b ON qis.branch_id = b.id
          LEFT JOIN branch_transfers bt ON qis.transfer_id = bt.id
          LEFT JOIN purchase_request_items pri ON qis.purchase_request_item_id = pri.id
          LEFT JOIN purchase_requests pr ON pri.pr_id = pr.id
          WHERE qis.quotation_item_id IN (${placeholders})`,
    args: ids,
  });
  const byItem = {};
  for (const s of sources) { (byItem[s.quotation_item_id] = byItem[s.quotation_item_id] || []).push(s); }
  for (const item of items) { item.sources = byItem[item.id] || []; }
  return items;
}

// Live price/availability for a Special Project rental line while it's being
// entered: the catalog rate over the period, and how many are free to hold
// at the branch right now.
router.post('/rental-line-estimate', requirePermission('special_projects'), async (req, res) => {
  try {
    const { product_id, quantity, rental_start, rental_end, branch_id } = req.body;
    const rate_plan = req.body.rate_plan || null;
    const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [product_id] });
    if (!product || !product.is_rental) return res.status(400).json({ error: 'Not a rental item' });
    const qty = parseInt(quantity) || 1;
    let period;
    try { period = rentalLinePeriod(rental_start, rental_end); } catch(e) { return res.status(400).json({ error: e.message }); }
    const planError = ratePlanError(rate_plan, period.start, period.end, [rateLineOf({ product })]);
    if (planError) return res.status(400).json({ error: planError });
    const fee = feeFor({ ...product, rate_plan }, qty, period.start, period.end);
    let available = null;
    if (branch_id) {
      const branchStock = await getBranchStock(db, product.id, branch_id, product.stock_qty);
      available = Math.max(0, branchStock - await getOutstandingQty(db, product.id, branch_id) - await getOutOfServiceQty(db, product.id, branch_id));
    }
    res.json({ days: period.days, fee, unit_price: parseFloat((fee / qty).toFixed(2)), available, tax_rate: product.tax_rate || 0, cost: product.cost ?? null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows: [quote] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name, c.customer_number, c.customer_type, c.email as customer_email, c.phone as customer_phone, c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip, e.first_name || ' ' || e.last_name as employee_name, oe.first_name || ' ' || oe.last_name as original_employee_name, ae.first_name || ' ' || ae.last_name as approved_by_name, re.first_name || ' ' || re.last_name as rejected_by_name, b.name as branch_name, t.transaction_number as converted_tx_number, ra.agreement_number as converted_agreement_number, ra.status as converted_agreement_status, ${IS_SPECIAL_ORDER_SQL} as is_special_order FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN employees e ON q.employee_id = e.id LEFT JOIN employees oe ON q.original_employee_id = oe.id LEFT JOIN employees ae ON q.approved_by = ae.id LEFT JOIN employees re ON q.rejected_by = re.id LEFT JOIN branches b ON q.branch_id = b.id LEFT JOIN transactions t ON q.converted_to_tx = t.id LEFT JOIN rental_agreements ra ON q.converted_to_agreement_id = ra.id WHERE q.id = ?`, args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    if (quote.quote_type === 'special_project' && !canSeeSpecialProjects(req)) return res.status(403).json({ error: 'Missing permission: special_projects' });
    const { rows: items } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [req.params.id] });
    quote.items = await attachQuoteItemSources(items);
    await attachSpecialProjectRentals(quote.items);
    if (quote.quote_type === 'rental') {
      await attachRentalRates(db, quote.items);
      for (const i of quote.items) i.rate_plan = quote.rate_plan;
      attachRateBasis(quote.items, rentalWindow(quote.created_at, quote.due_date));
      quote.rental_summary = rentalQuoteSummary(quote);
      quote.total = quote.rental_summary.total;
    }
    res.json(quote);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// A Special Project rental line's period: whole days from the start date to
// the end date (the rental's due date). Throws a user-facing error.
function rentalLinePeriod(startDate, endDate) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(String(startDate || '')) || !iso.test(String(endDate || ''))) throw new Error('Each rental item needs a start and end date');
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!(end > start)) throw new Error('A rental item\'s end date must be after its start date');
  return { start, end, days: Math.round((end - start) / 86400000) };
}

const fmtRentalDate = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const rentalLineLabel = (name, { start, end, days }) => `${name} — Rental ${fmtRentalDate(start)} to ${fmtRentalDate(end)} (${days} day${days === 1 ? '' : 's'})`;

// Special Project rental line ({is_rental_line, product_id, quantity,
// rental_start, rental_end, unit_price?}) -> the line plus a $0 child line for
// each mandatory accessory (they're held and issued with it, like on a
// normal rental). unit_price is the per-unit charge for the whole period —
// defaults to the catalog rate over the period (feeFor), but is editable
// like any Special Project price.
async function processRentalLine(item, product, parentIndex) {
  if (!product.is_rental) throw new Error(`"${product.name}" is not a rental item`);
  const period = rentalLinePeriod(item.rental_start, item.rental_end);
  const qty = parseInt(item.quantity) || 1;
  const rate_plan = item.rate_plan || null;
  const planError = ratePlanError(rate_plan, period.start, period.end, [rateLineOf({ product })]);
  if (planError) throw new Error(`${product.name}: ${planError}`);
  const estimate = feeFor({ ...product, rate_plan }, qty, period.start, period.end);
  const unit_price = item.unit_price != null && item.unit_price !== '' ? parseFloat(item.unit_price) : parseFloat((estimate / qty).toFixed(2));
  const lineTotal = parseFloat((unit_price * qty).toFixed(2));
  const lines = [{
    product_id: product.id, product_name: rentalLineLabel(product.name, period), serial_number: null, sku: product.sku,
    is_temp_item: 0, is_q_item: 0, purchase_request_id: null, sources: null,
    qty, unit_price, unit_cost: item.unit_cost != null && item.unit_cost !== '' ? parseFloat(item.unit_cost) : null,
    lineTotal, lineTax: parseFloat((lineTotal * (product.tax_rate || 0) / 100).toFixed(2)), taxRate: product.tax_rate || 0, lineDisc: parseFloat(item.discount || 0),
    is_rental_line: 1, rental_start: item.rental_start, rental_end: item.rental_end, is_mandatory: 0, parentIndex: null, rate_plan,
  }];
  const { rows: accessories } = await db.execute({ sql: 'SELECT pa.*, p.name, p.sku, p.is_rental FROM product_accessories pa JOIN products p ON p.id = pa.accessory_product_id WHERE pa.product_id = ? AND pa.is_mandatory = 1', args: [product.id] });
  for (const acc of accessories) {
    if (!acc.is_rental) continue;
    lines.push({
      product_id: acc.accessory_product_id, product_name: `${acc.name} (included with ${product.name})`, serial_number: null, sku: acc.sku,
      is_temp_item: 0, is_q_item: 0, purchase_request_id: null, sources: null,
      qty, unit_price: 0, unit_cost: null, lineTotal: 0, lineTax: 0, taxRate: 0, lineDisc: 0,
      is_rental_line: 1, rental_start: item.rental_start, rental_end: item.rental_end, is_mandatory: 1, parentIndex, rate_plan,
    });
  }
  return lines;
}

// Check-out/check-in details for a Special Project's rental lines, from each
// line's rental agreement — shown on the project's view (item.rental).
async function attachSpecialProjectRentals(items) {
  const ids = [...new Set(items.filter(i => i.rental_agreement_id && !i.parent_item_id).map(i => i.rental_agreement_id))];
  for (const id of ids) {
    const { rows: [ag] } = await db.execute({ sql: `SELECT ra.id, ra.agreement_number, ra.status, ra.due_date, ra.checkout_datetime, ra.returned_at, ra.is_paused,
        ra.damage_fee_total, ra.duration_adjustment_total, ra.tax_adjustment_total, ra.deposit_total, ra.settlement_transaction_id,
        (ra.damage_fee_total + ra.duration_adjustment_total - ra.deposit_total + ra.tax_adjustment_total + ra.service_adjustment_total) as balance_due,
        ise.first_name || ' ' || ise.last_name as issued_by_name, rse.first_name || ' ' || rse.last_name as returned_by_name,
        st.transaction_number as settlement_transaction_number,
        CASE WHEN ra.status = 'awaiting_issue' AND ra.delivery_driver_confirmed_at IS NOT NULL THEN 'out_for_delivery'
             WHEN ra.status = 'active' AND ra.is_paused = 1 THEN 'paused'
             WHEN ra.status = 'active' AND ra.due_date < date('now') THEN 'overdue'
             WHEN ra.status = 'returned' AND ra.settlement_transaction_id IS NULL AND (ra.damage_fee_total + ra.duration_adjustment_total - ra.deposit_total + ra.tax_adjustment_total + ra.service_adjustment_total) > 0 THEN 'returned_unpaid'
             ELSE ra.status END as display_status
      FROM rental_agreements ra
      LEFT JOIN employees ise ON ra.issue_security_employee_id = ise.id
      LEFT JOIN employees rse ON ra.return_security_employee_id = rse.id
      LEFT JOIN transactions st ON ra.settlement_transaction_id = st.id
      WHERE ra.id = ?`, args: [id] });
    if (!ag) continue;
    const { rows: agItems } = await db.execute({ sql: 'SELECT product_name, quantity, quantity_returned, condition_out, condition_in, damage_fee, damage_notes, rental_fee, final_rental_fee, is_mandatory FROM rental_agreement_items WHERE agreement_id = ? ORDER BY id', args: [id] });
    ag.items = agItems;
    for (const item of items) if (item.rental_agreement_id === id && !item.parent_item_id) item.rental = ag;
  }
}

// Items either reference a real product (`product_id`) or are temporary,
// off-catalog lines (`description` + `unit_price`, no `product_id`) used to
// quote something not yet in inventory ("Q" items). Shared by create and edit.
// Temp items are taxed at the store's default rate (no product to read a
// rate from). `purchase_request_id` is carried through unchanged when an
// existing Q item is re-saved, so editing a quote doesn't spawn duplicate PRs.
//
// A real-product item may also carry `sources`: [{branch_id, quantity}], used
// when the quote's branch can't cover the full quantity and the user split
// sourcing across other branches (branch_id null = "no branch has enough,
// purchase it"). Only set when a split was actually needed — omitted entirely
// for the common case where the quote's own branch has enough stock.
// The quote's Discount comes off before tax, the same way the POS does it at
// checkout (lib/ticketDiscount.js): spread over the lines by amount, and
// each line re-taxed on what's left. Updates the lines' lineTax in place.
function applyQuoteDiscount(processedItems, discount) {
  const split = allocateTicketDiscount(processedItems.map(l => l.lineTotal), discount);
  let tax_amount = 0;
  processedItems.forEach((l, i) => {
    l.lineTax = parseFloat(((l.lineTotal - split.shares[i]) * (l.taxRate || 0) / 100).toFixed(2));
    tax_amount += l.lineTax;
  });
  return { discount: split.discount, tax_amount: parseFloat(tax_amount.toFixed(2)) };
}

async function processQuoteItems(items, { allowRental = false } = {}) {
  const { rows: [taxSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='tax_rate'", args: [] });
  const defaultTaxRate = parseFloat(taxSetting?.value) || 0;

  let subtotal = 0, tax_amount = 0;
  const processedItems = [];
  for (const item of items) {
    if (item.is_rental_line) {
      if (!allowRental) throw new Error('Rental items can only be added to a Special Project');
      const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!p) throw new Error(`Product ${item.product_id} not found`);
      const lines = await processRentalLine(item, p, processedItems.length);
      for (const line of lines) { subtotal += line.lineTotal; tax_amount += line.lineTax; processedItems.push(line); }
      continue;
    }
    // "C" (comment) line — free text printed on the quote and carried onto
    // the sale; no price or tax, not a Q item, never goes to Purchasing.
    if (!item.product_id && item.is_comment) {
      const text = String(item.description || item.product_name || '').trim();
      if (!text) continue;
      processedItems.push({
        product_id: null, product_name: text, sell_unit: null, units_per: 1, uom_id: null, serial_number: null, sku: null,
        is_temp_item: 0, is_q_item: 0, is_comment: 1, purchase_request_id: null, sources: null,
        qty: 1, unit_price: 0, unit_cost: null, lineTotal: 0, lineTax: 0, taxRate: 0, lineDisc: 0,
      });
      continue;
    }
    // Delivery line — description + pre-tax price, taxed at the store's
    // default rate. Not a temp/Q item, so it never goes to Purchasing.
    if (!item.product_id && item.is_delivery) {
      const text = String(item.description || item.product_name || '').trim() || 'Delivery';
      const unit_price = parseFloat(item.unit_price);
      if (!(unit_price >= 0)) throw new Error(`Enter a price for the delivery line "${text}"`);
      const lineTotal = parseFloat(unit_price.toFixed(2));
      const lineTax = parseFloat((lineTotal * defaultTaxRate / 100).toFixed(2));
      subtotal += lineTotal;
      tax_amount += lineTax;
      processedItems.push({
        product_id: null, product_name: text, sell_unit: null, units_per: 1, uom_id: null, serial_number: null, sku: null,
        is_temp_item: 0, is_q_item: 0, is_delivery: 1, purchase_request_id: null, sources: null,
        qty: 1, unit_price: lineTotal, unit_cost: null, lineTotal, lineTax, taxRate: defaultTaxRate, lineDisc: 0,
      });
      continue;
    }
    let product = null;
    if (item.product_id) {
      const { rows: [p] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
      if (!p) throw new Error(`Product ${item.product_id} not found`);
      product = p;
    } else if (!item.description || !String(item.description).trim()) {
      throw new Error('Item must have a product_id or a description');
    }
    // Blank serial on an SN line → drop the line (serials are optional).
    const isSN = isSerialNumberProduct(product);
    const serial_number = isSN ? serialNumberOf(item) : null;
    if (isSN && !serial_number) continue;
    if (serial_number) { const clash = await serialClashError(db, serial_number); if (clash) throw new Error(clash); }
    // Unit of measure (lib/units.js): the unit's price by default, cost of
    // that many stock units, and part quantities for a decimal unit.
    const unit = product && !serial_number ? await resolveUnit(db, product, item.uom_id ?? item.sell_unit) : { uom_id: null, sell_unit: null, units_per: 1, allow_decimal: 0 };
    const qty = serial_number ? 1 : product ? parseQty(item.quantity || 1, unit.allow_decimal) : (parseInt(item.quantity) || 1);
    if (Number.isNaN(qty)) throw new Error(`${product.name} is quoted in whole ${unit.sell_unit || 'unit'}s — the quantity can't be ${item.quantity}`);
    const unit_price = parseFloat(item.unit_price ?? (product ? unit.price : 0));
    const lineTotal = parseFloat((unit_price * qty).toFixed(2));
    const taxRate = product ? product.tax_rate : defaultTaxRate;
    const lineTax = parseFloat((lineTotal * taxRate / 100).toFixed(2));
    const lineDisc = parseFloat(item.discount || 0);
    subtotal += lineTotal;
    tax_amount += lineTax;
    // Informational cost snapshot (margin/markup visibility on Special
    // Projects lines) — explicit unit_cost wins, else defaults to the
    // catalog product's cost, else null for a custom line with no cost
    // entered. Never affects subtotal/tax/total.
    const unit_cost = item.unit_cost != null && item.unit_cost !== '' ? parseFloat(item.unit_cost) : (product ? Math.round((product.cost || 0) * unit.units_per * 10000) / 10000 : null);
    let sources = null;
    if (product && !serial_number && Array.isArray(item.sources) && item.sources.length) {
      const srcQty = q => Math.round((Number(q) || 0) * 1000) / 1000;
      const sourcesSum = srcQty(item.sources.reduce((s, src) => s + srcQty(src.quantity), 0));
      if (sourcesSum !== qty) throw new Error(`Branch sourcing for ${product.name} (${sourcesSum}) doesn't match quantity (${qty})`);
      sources = item.sources.map(src => ({ branch_id: src.branch_id || null, quantity: srcQty(src.quantity) })).filter(src => src.quantity > 0);
    }
    processedItems.push({
      product_id: product ? product.id : null,
      product_name: serial_number ? serialNumberLabel(serial_number) : product ? lineName(product.name, unit) : String(item.description).trim(),
      sell_unit: unit.sell_unit, units_per: unit.units_per, uom_id: unit.uom_id ?? null,
      serial_number,
      sku: product ? product.sku : null,
      is_temp_item: product ? 0 : 1,
      is_q_item: !product && item.is_q_item ? 1 : 0,
      purchase_request_id: product ? null : (item.purchase_request_id || null),
      sources,
      qty, unit_price, unit_cost, lineTotal, lineTax, taxRate, lineDisc,
    });
  }
  if (!processedItems.some(l => !l.is_comment)) throw new Error('No items in quotation');
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    tax_amount: parseFloat(tax_amount.toFixed(2)),
    processedItems,
  };
}

// Rental-quote counterpart to processQuoteItems above. `items` here are raw
// picks ({product_id, quantity, condition_out, accessory_ids}), validated
// and accessory-expanded by lib/rentals.js's buildRentalLines (shared with
// the direct rental-hold flow in routes/rentals.js POST /agreements) — same
// availability rules, same mandatory/optional accessory handling. No
// `sources`/branch-split concept exists for rentals: a rental quote only
// ever checks stock at its own single branch, same as a direct rental hold.
//
// The per-line total here is a NON-BINDING ESTIMATE only, computed via
// feeFor() over [now, due_date] — the real charge is always recomputed
// fresh at actual rental checkout finalize time (PATCH
// /rentals/agreements/:id/checkout), from live product rates over the
// actual [checkout-instant, due_date] window, exactly like a direct rental
// hold already works. Because rental billing is nonlinear (month/week/day/
// hour blocks), `unit_price` (the product's daily rate) deliberately does
// NOT satisfy `unit_price * quantity === total` here, unlike every retail
// quotation_items row — it's informational only.
async function processRentalQuoteItems(items, branch_id, due_date, rate_plan = null) {
  if (!branch_id) throw new Error('A branch/location is required for a rental quote');
  if (!due_date) throw new Error('Due date is required for a rental quote');

  const lines = await buildRentalLines(db, { branch_id, items });
  // Same window checkout bills (PATCH /rentals/agreements/:id/checkout):
  // due date at the same time of day the rental starts, not end of day —
  // otherwise the quote can bill an extra partial/whole day checkout won't.
  // Whole seconds, same as checkout — see PATCH /rentals/agreements/:id/checkout.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const due = new Date(`${due_date}T${now.toISOString().slice(11, 19)}.000Z`);
  const planError = ratePlanError(rate_plan, now, due, lines.filter(l => !l.isMandatory).map(rateLineOf));
  if (planError) throw new Error(planError);

  let subtotal = 0, tax_amount = 0;
  const processedItems = lines.map(line => {
    const p = line.product;
    const estFee = line.isMandatory ? 0 : feeFor({ ...p, rate_plan }, line.quantity, now, due);
    const lineTax = parseFloat((estFee * (p.tax_rate || 0) / 100).toFixed(2));
    subtotal += estFee;
    tax_amount += lineTax;
    return {
      product_id: p.id, product_name: p.name, sku: p.sku,
      quantity: line.quantity, unit_price: p.rental_rate || 0,
      lineTotal: estFee, lineTax, is_mandatory: line.isMandatory ? 1 : 0,
      condition_out: line.condition_out, parentIndex: line.parentIndex,
    };
  });
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    tax_amount: parseFloat(tax_amount.toFixed(2)),
    processedItems,
  };
}

// ─── Special Project rental holds ────────────────────────────────────────
// Approving a Special Project holds each rental line's item(s): one pending
// rental agreement per line (with its mandatory accessories), due back on the
// line's end date. A pending agreement already counts against availability
// (lib/rentalAvailability.js), so nobody else can rent it from then on. Its
// rental_fee is the line's approved price — the project invoice is what
// charges it, so the agreement can't be checked out on its own
// (PATCH /rentals/agreements/:id/checkout refuses it). Paying the invoice at
// the POS moves it to awaiting_issue (POST /transactions), and from there it's
// issued and returned like any rental. No deposit: the project invoice is
// the customer's commitment.
async function holdSpecialProjectRentals(tx, quote, employeeId) {
  const { rows: items } = await tx.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ? AND is_rental_line = 1 ORDER BY id', args: [quote.id] });
  const parents = items.filter(i => i.parent_item_id == null && !i.rental_agreement_id);
  if (!parents.length) return;
  if (!quote.customer_id) throw new Error('Choose a customer before approving — the rental items are held in their name');
  if (!quote.branch_id) throw new Error('Choose a branch before approving — the rental items are held at that branch');
  const { rows: [customer] } = await tx.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [quote.customer_id] });
  assertRentalCustomerEligible(customer);
  await assertNoUnpaidRentalReturns(tx, customer);

  for (const parent of parents) {
    const group = [parent, ...items.filter(i => i.parent_item_id === parent.id)];
    let lines;
    try { lines = await revalidateQuoteLines(tx, { branch_id: quote.branch_id, quotationItems: group }); }
    catch(e) { throw new Error(`Can't hold the rental item on this project: ${e.message}`); }
    const agreement_number = await nextNumber(tx, 'rental_agreements', 'agreement_number', 'RA-', 6);
    const agreementId = await insertPendingAgreement(tx, {
      agreement_number, customer_id: quote.customer_id, employee_id: employeeId || quote.employee_id || null,
      branch_id: quote.branch_id, due_date: parent.rental_end,
      notes: `Special Project ${quote.quote_number} — rental ${parent.rental_start} to ${parent.rental_end}`, lines,
      rate_plan: parent.rate_plan || null,
    });
    await tx.execute({ sql: 'UPDATE rental_agreements SET quotation_id = ? WHERE id = ?', args: [quote.id, agreementId] });
    // insertPendingAgreement inserts in `lines` order, which is `group` order.
    const { rows: agItems } = await tx.execute({ sql: 'SELECT id FROM rental_agreement_items WHERE agreement_id = ? ORDER BY id', args: [agreementId] });
    for (let i = 0; i < group.length; i++) {
      await tx.execute({ sql: 'UPDATE rental_agreement_items SET rental_fee = ? WHERE id = ?', args: [group[i].is_mandatory ? 0 : group[i].total, agItems[i].id] });
      await tx.execute({ sql: 'UPDATE quotation_items SET rental_agreement_id = ? WHERE id = ?', args: [agreementId, group[i].id] });
    }
  }
}

// Cancels the project's still-pending holds (back to Draft, declined) so the
// items are free again; re-approving creates fresh ones.
async function releaseSpecialProjectRentals(executor, quoteId, reason, employeeId) {
  const { rows } = await executor.execute({ sql: "SELECT id FROM rental_agreements WHERE quotation_id = ? AND status = 'pending'", args: [quoteId] });
  for (const { id } of rows) {
    await executor.execute({ sql: "UPDATE rental_agreements SET status = 'cancelled', cancellation_reason = ?, cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", args: [reason, employeeId || null, id] });
    await executor.execute({ sql: 'UPDATE quotation_items SET rental_agreement_id = NULL WHERE rental_agreement_id = ?', args: [id] });
  }
}

// Finds the quote's existing auto-created Purchase Request (from an earlier
// accept — e.g. the quote was reverted to draft, edited, then re-accepted) or
// creates a new one. One PR per quote, shared by both custom "Q" items and
// real-product shortfalls that no branch could cover.
async function ensureQuotePR(quote) {
  const { rows: [existingLink] } = await db.execute({ sql: 'SELECT purchase_request_id FROM quotation_items WHERE quote_id = ? AND purchase_request_id IS NOT NULL LIMIT 1', args: [quote.id] });
  if (existingLink) return existingLink.purchase_request_id;
  const { rows: [existingSourceLink] } = await db.execute({
    sql: `SELECT pri.pr_id FROM quotation_item_sources qis
          JOIN quotation_items qi ON qis.quotation_item_id = qi.id
          JOIN purchase_request_items pri ON qis.purchase_request_item_id = pri.id
          WHERE qi.quote_id = ? LIMIT 1`,
    args: [quote.id],
  });
  if (existingSourceLink) return existingSourceLink.pr_id;

  const pr_number = await nextNumber(db, 'purchase_requests', 'pr_number', 'PR-', 6);
  const result = await db.execute({
    sql: 'INSERT INTO purchase_requests (pr_number, branch_id, employee_id, notes, required_date, request_type) VALUES (?,?,?,?,?,?)',
    args: [pr_number, quote.branch_id || null, quote.employee_id || null, `Auto-created from accepted quotation ${quote.quote_number} — customer PO received`, quote.valid_until || null, 'sale_items']
  });
  return Number(result.lastInsertRowid);
}

// Flags every not-yet-flagged item on an accepted quote for Purchasing, in a
// single Purchase Request per quote (not one per item). Two sources feed the
// same PR: custom "Q" items (no product_id — not yet in the catalog at all),
// and real-product line items where a branch split left a remainder no
// branch could cover (quotation_item_sources.branch_id IS NULL). Only runs
// once the customer has accepted the quote — never at create/edit time,
// since items are still in flux until then.
//
// `qItemsOnly` (Special Projects): only custom lines explicitly added as Q
// items (is_q_item) are flagged — the project's other custom lines are
// labour/fees, not things to buy — and branch shortfalls are left alone.
async function flagItemsForPurchasing(quote, { qItemsOnly = false } = {}) {
  try {
    const { rows: unflaggedQItems } = await db.execute({ sql: `SELECT * FROM quotation_items WHERE quote_id = ? AND is_temp_item = 1 AND purchase_request_id IS NULL${qItemsOnly ? ' AND is_q_item = 1' : ''}`, args: [quote.id] });
    const { rows: shortfalls } = qItemsOnly ? { rows: [] } : await db.execute({
      sql: `SELECT qis.id as source_id, qi.id as item_id, qi.product_id, qi.product_name, qi.unit_price, qi.discount_amount, qis.quantity
            FROM quotation_item_sources qis JOIN quotation_items qi ON qis.quotation_item_id = qi.id
            WHERE qi.quote_id = ? AND qis.branch_id IS NULL AND qis.purchase_request_item_id IS NULL`,
      args: [quote.id],
    });
    if (!unflaggedQItems.length && !shortfalls.length) return;

    const prId = await ensureQuotePR(quote);

    // A discount noted on the quote line (see quotation_items.discount_amount)
    // is carried forward here, and again at PR→PO conversion — purely
    // informational, but worth an approver seeing before signing off, since
    // it means this purchase is backing an item sold below list price.
    const discountNote = amt => amt > 0 ? ` (quoted with a ${parseFloat(amt).toFixed(2)} discount)` : '';

    for (const item of unflaggedQItems) {
      // Bring the quoted price forward as the starting est. cost — Purchasing
      // can adjust it once they've actually sourced the item.
      const unitCost = item.unit_price;
      const total = parseFloat((unitCost * item.quantity).toFixed(2));
      await db.execute({
        sql: 'INSERT INTO purchase_request_items (pr_id, product_name, quantity, unit_cost, item_type, notes, total, quotation_item_id, discount_amount) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [prId, item.product_name, item.quantity, unitCost, 'sale', `Quoted at ${item.unit_price}/unit on ${quote.quote_number}${discountNote(item.discount_amount)}`, total, item.id, item.discount_amount || 0]
      });
      await db.execute({ sql: 'UPDATE quotation_items SET purchase_request_id = ? WHERE id = ?', args: [prId, item.id] });
    }

    for (const s of shortfalls) {
      const unitCost = s.unit_price;
      const total = parseFloat((unitCost * s.quantity).toFixed(2));
      const result = await db.execute({
        sql: 'INSERT INTO purchase_request_items (pr_id, product_id, product_name, quantity, unit_cost, item_type, notes, total, quotation_item_id, discount_amount) VALUES (?,?,?,?,?,?,?,?,?,?)',
        args: [prId, s.product_id, s.product_name, s.quantity, unitCost, 'sale', `No branch had enough stock — quoted at ${s.unit_price}/unit on ${quote.quote_number}${discountNote(s.discount_amount)}`, total, s.item_id, s.discount_amount || 0]
      });
      await db.execute({ sql: 'UPDATE quotation_item_sources SET purchase_request_item_id = ? WHERE id = ?', args: [Number(result.lastInsertRowid), s.source_id] });
    }
  } catch(e) { /* non-fatal: the status change itself already succeeded */ }
}

// Auto-creates a branch transfer for each distinct non-home branch a quote's
// items were sourced from (one transfer per branch per quote, mirroring the
// "one PR per quote" grouping used for shortfalls), referencing the quote.
// If stock at a source branch has changed since the quote was drafted and the
// transfer can no longer be created, that group's sourcing is rerouted to the
// "purchase" bucket (branch_id = NULL) so flagItemsForPurchasing sweeps it
// into the PR instead — Accept never hard-fails because of a stale quote.
async function processQuoteTransfers(quote) {
  try {
    if (!quote.branch_id) return;
    const { rows: pending } = await db.execute({
      sql: `SELECT qis.id as source_id, qis.branch_id, qis.quantity, qi.product_id
            FROM quotation_item_sources qis JOIN quotation_items qi ON qis.quotation_item_id = qi.id
            WHERE qi.quote_id = ? AND qis.branch_id IS NOT NULL AND qis.branch_id != ? AND qis.transfer_id IS NULL`,
      args: [quote.id, quote.branch_id],
    });
    if (!pending.length) return;

    const byBranch = {};
    for (const row of pending) { (byBranch[row.branch_id] = byBranch[row.branch_id] || []).push(row); }

    for (const [branchId, rows] of Object.entries(byBranch)) {
      const tx = await db.transaction('write');
      let committed = false;
      try {
        const transfer_number = await nextNumber(tx, 'branch_transfers', 'transfer_number', 'TRF-', 6);
        const items = rows.map(r => ({ product_id: r.product_id, quantity: r.quantity }));
        const transferId = await createTransfer(tx, {
          transfer_number, from_branch_id: Number(branchId), to_branch_id: quote.branch_id,
          employee_id: quote.employee_id, items, notes: `Auto-created from accepted quotation ${quote.quote_number}`,
          quote_id: quote.id,
        });
        for (const r of rows) {
          await tx.execute({ sql: 'UPDATE quotation_item_sources SET transfer_id = ? WHERE id = ?', args: [transferId, r.source_id] });
        }
        await tx.commit();
        committed = true;
      } catch(e) {
        // Only fall back to purchasing if the transfer itself never committed —
        // rolling back an already-committed tx throws, and would otherwise
        // wrongly reroute a successfully-transferred item into the PR bucket.
        if (committed) throw e;
        await tx.rollback();
        // Source branch can no longer cover it — fall back to purchasing.
        for (const r of rows) {
          await db.execute({ sql: 'UPDATE quotation_item_sources SET branch_id = NULL WHERE id = ?', args: [r.source_id] });
        }
      }
    }
  } catch(e) { /* non-fatal: the status change itself already succeeded */ }
}

async function processQuoteAcceptance(quote) {
  // A Special Project's ordinary custom lines (labour, equipment rental
  // fees, etc.) aren't things to buy, and it never auto-creates branch
  // transfers — only the lines added as Q items go to Purchasing.
  if (quote.quote_type === 'special_project') return flagItemsForPurchasing(quote, { qItemsOnly: true });
  await processQuoteTransfers(quote);
  await flagItemsForPurchasing(quote);
}

router.post('/', async (req, res) => {
  try {
    const {
      customer_id, employee_id, branch_id, items, discount_amount, notes, valid_until, quote_type, due_date,
      delivery_required, delivery_cost, delivery_address, pickup_required, pickup_cost, pickup_address, operator_required, operator_fee,
    } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in quotation' });
    const isRental = quote_type === 'rental';
    const ratePlan = isRental ? (req.body.rate_plan || null) : null;
    if (isRental && delivery_required && !String(delivery_address || '').trim()) return res.status(400).json({ error: "Enter the delivery address — ask the customer where it's going, even if it's their own address" });
    if (isRental && pickup_required && !String(pickup_address || '').trim()) return res.status(400).json({ error: "Enter the pickup address — ask the customer where it's being collected from, even if it's their own address" });
    const isSpecialProject = quote_type === 'special_project';
    if (isSpecialProject && !req.apiKey && !can(req.employee && req.employee.permissions, 'special_projects')) {
      return res.status(403).json({ error: 'Missing permission: special_projects' });
    }
    // Retail quotes default to a 30-day validity window when the caller
    // doesn't specify one — the UI already pre-fills this (see
    // _applyQuoteTypeVisibility in public/index.html), but this covers any
    // other caller (an API key, say) that posts a retail quote directly.
    const retailValidUntil = (!isRental && !isSpecialProject && !valid_until)
      ? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
      : valid_until;

    const quote_number = await nextNumber(db, 'quotations', 'quote_number', 'QT-', 6);

    let subtotal, tax_amount, processedItems;
    try {
      ({ subtotal, tax_amount, processedItems } = isRental
        ? await processRentalQuoteItems(items, branch_id, due_date, ratePlan)
        : await processQuoteItems(items, { allowRental: isSpecialProject }));
    } catch(e) { return res.status(400).json({ error: e.message }); }
    let disc = parseFloat(discount_amount || 0);
    if (!isRental) ({ discount: disc, tax_amount } = applyQuoteDiscount(processedItems, disc));
    const total = isRental
      ? rentalQuoteSummary({ subtotal, tax_amount, discount_amount: disc, delivery_required, delivery_cost, pickup_required, pickup_cost, operator_required, operator_fee, customer_type: await customerTypeOf(customer_id) }).total
      : parseFloat((subtotal - disc + tax_amount).toFixed(2));

    const tx = await db.transaction('write');
    let committed = false;
    try {
      // original_employee_id starts equal to employee_id — it only ever
      // diverges once PATCH /:id/reassign moves employee_id to someone else,
      // at which point this stays put as the commission-credit target (see
      // POST /transactions' quote_id handling).
      const result = await tx.execute({ sql: `INSERT INTO quotations
        (quote_number,customer_id,employee_id,original_employee_id,branch_id,subtotal,tax_amount,discount_amount,total,notes,valid_until,quote_type,due_date,
         delivery_required,delivery_cost,delivery_address,pickup_required,pickup_cost,operator_required,operator_fee,pickup_address,rate_plan,po_number)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [quote_number, customer_id||null, employee_id||null, employee_id||null, branch_id||null, subtotal, tax_amount, disc, total, notes||null, retailValidUntil||null, isRental ? 'rental' : (isSpecialProject ? 'special_project' : 'retail'), isRental ? due_date : null,
          isRental && delivery_required ? 1 : 0, isRental && delivery_required ? parseFloat(delivery_cost||0) : 0, isRental && delivery_required ? (delivery_address||null) : null,
          isRental && pickup_required ? 1 : 0, isRental && pickup_required ? parseFloat(pickup_cost||0) : 0,
          isRental && operator_required ? 1 : 0, isRental && operator_required ? parseFloat(operator_fee||0) : 0,
          isRental && pickup_required ? String(pickup_address).trim() : null, ratePlan, String(req.body.po_number || '').trim() || null] });
      const quoteId = Number(result.lastInsertRowid);
      if (isRental) {
        // No sources/branch-split concept for rentals — a rental quote only
        // ever checks stock at its own branch (see processRentalQuoteItems).
        // parent_item_id needs real row ids, which only exist post-insert —
        // set it in a second pass, same as lib/rentals.js's insertPendingAgreement.
        for (const item of processedItems) {
          const { product_id, product_name, sku, quantity, unit_price, lineTotal, lineTax, is_mandatory, condition_out } = item;
          const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,is_temp_item,is_mandatory,condition_out) VALUES (?,?,?,?,?,?,0,?,?,0,?,?)', args: [quoteId, product_id, product_name, sku, quantity, unit_price, lineTax, lineTotal, is_mandatory, condition_out] });
          item.id = Number(itemResult.lastInsertRowid);
        }
        for (const item of processedItems) {
          if (item.parentIndex != null) {
            await tx.execute({ sql: 'UPDATE quotation_items SET parent_item_id = ? WHERE id = ?', args: [processedItems[item.parentIndex].id, item.id] });
          }
        }
      } else {
        await insertQuoteLines(tx, quoteId, processedItems);
      }
      await tx.commit();
      committed = true;
      const { rows: [quote] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ?`, args: [quoteId] });
      const { rows: quoteItems } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [quoteId] });
      quote.items = isRental ? quoteItems : await attachQuoteItemSources(quoteItems);
      res.status(201).json(quote);
    } catch(e) {
      // Once committed, the quote is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit a quotation (details + items) before it's converted to an invoice.
router.put('/:id', async (req, res) => {
  try {
    const { rows: [quote] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    if (quote.status === 'converted') return res.status(400).json({ error: 'Cannot edit a quotation already converted to an invoice' });
    if (quote.quote_type === 'special_project') {
      if (!req.apiKey && !can(req.employee && req.employee.permissions, 'special_projects')) return res.status(403).json({ error: 'Missing permission: special_projects' });
      // Editing after submission would silently invalidate an approval that
      // was already granted on different numbers — a special project can
      // only be edited while still a Draft. Rejecting it (back to Draft)
      // reopens editing the normal way.
      if (quote.status !== 'draft') return res.status(400).json({ error: `This special project is ${quote.status} — it can only be edited while in Draft` });
    }

    const {
      customer_id, employee_id, branch_id, items, discount_amount, notes, valid_until, due_date,
      delivery_required, delivery_cost, delivery_address, pickup_required, pickup_cost, pickup_address, operator_required, operator_fee,
    } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in quotation' });
    const isRental = quote.quote_type === 'rental'; // quote_type is fixed at creation — never taken from req.body here
    const ratePlan = isRental ? (req.body.rate_plan || null) : null;
    if (isRental && delivery_required && !String(delivery_address || '').trim()) return res.status(400).json({ error: "Enter the delivery address — ask the customer where it's going, even if it's their own address" });
    if (isRental && pickup_required && !String(pickup_address || '').trim()) return res.status(400).json({ error: "Enter the pickup address — ask the customer where it's being collected from, even if it's their own address" });

    let subtotal, tax_amount, processedItems;
    try {
      ({ subtotal, tax_amount, processedItems } = isRental
        ? await processRentalQuoteItems(items, branch_id, due_date || quote.due_date, ratePlan)
        : await processQuoteItems(items, { allowRental: quote.quote_type === 'special_project' }));
    } catch(e) { return res.status(400).json({ error: e.message }); }
    let disc = parseFloat(discount_amount || 0);
    if (!isRental) ({ discount: disc, tax_amount } = applyQuoteDiscount(processedItems, disc));
    const total = isRental
      ? rentalQuoteSummary({ subtotal, tax_amount, discount_amount: disc, delivery_required, delivery_cost, pickup_required, pickup_cost, operator_required, operator_fee, customer_type: await customerTypeOf(customer_id) }).total
      : parseFloat((subtotal - disc + tax_amount).toFixed(2));

    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({ sql: `UPDATE quotations SET customer_id=?, employee_id=?, branch_id=?, subtotal=?, tax_amount=?, discount_amount=?, total=?, notes=?, valid_until=?, due_date=?,
        delivery_required=?, delivery_cost=?, delivery_address=?, pickup_required=?, pickup_cost=?, operator_required=?, operator_fee=?, pickup_address=?, rate_plan=?, po_number=? WHERE id=?`,
        args: [customer_id||null, employee_id||quote.employee_id||null, branch_id||null, subtotal, tax_amount, disc, total, notes||null, valid_until||null, isRental ? (due_date || quote.due_date) : null,
          isRental && delivery_required ? 1 : 0, isRental && delivery_required ? parseFloat(delivery_cost||0) : 0, isRental && delivery_required ? (delivery_address||null) : null,
          isRental && pickup_required ? 1 : 0, isRental && pickup_required ? parseFloat(pickup_cost||0) : 0,
          isRental && operator_required ? 1 : 0, isRental && operator_required ? parseFloat(operator_fee||0) : 0,
          isRental && pickup_required ? String(pickup_address).trim() : null, ratePlan, String(req.body.po_number || '').trim() || null, quote.id] });
      await tx.execute({ sql: 'DELETE FROM quotation_items WHERE quote_id = ?', args: [quote.id] });
      if (isRental) {
        for (const item of processedItems) {
          const { product_id, product_name, sku, quantity, unit_price, lineTotal, lineTax, is_mandatory, condition_out } = item;
          const itemResult = await tx.execute({ sql: 'INSERT INTO quotation_items (quote_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,is_temp_item,is_mandatory,condition_out) VALUES (?,?,?,?,?,?,0,?,?,0,?,?)', args: [quote.id, product_id, product_name, sku, quantity, unit_price, lineTax, lineTotal, is_mandatory, condition_out] });
          item.id = Number(itemResult.lastInsertRowid);
        }
        for (const item of processedItems) {
          if (item.parentIndex != null) {
            await tx.execute({ sql: 'UPDATE quotation_items SET parent_item_id = ? WHERE id = ?', args: [processedItems[item.parentIndex].id, item.id] });
          }
        }
      } else {
        await insertQuoteLines(tx, quote.id, processedItems);
      }
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ?`, args: [quote.id] });
      // Quote was already accepted before this edit — any newly-added Q items
      // and shortfall sources still need to reach Purchasing/Transfers, so
      // reprocess now. NOTE: known limitation — since quotation_items (and by
      // cascade quotation_item_sources) are deleted and re-inserted on every
      // edit, sources that were already turned into a transfer/PR before this
      // edit lose that link and get reprocessed, which can create duplicates.
      // Not fixed in v1; see plan notes. Rentals have no PR/transfer concept
      // at all, so this reprocessing is retail-only.
      if (quote.status === 'accepted' && !isRental) await processQuoteAcceptance(updated);
      const { rows: quoteItems } = await db.execute({ sql: QUOTE_ITEMS_SELECT, args: [quote.id] });
      updated.items = isRental ? quoteItems : await attachQuoteItemSources(quoteItems);
      res.json(updated);
    } catch(e) {
      // Once committed, the edit is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Hand a quote off to a different salesperson to finish working it, while
// keeping commission credit with whoever it's currently attributed to (see
// POST /transactions' quote_id handling, which reads original_employee_id
// off the quote instead of the completing cashier's own id). Deliberately
// separate from the general PUT /:id edit — that one lets anyone who can
// edit a quote reassign employee_id too, but without this credit guarantee.
router.patch('/:id/reassign', requirePermission('sales_manager'), async (req, res) => {
  try {
    const { employee_id } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    const { rows: [quote] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    if (['converted', 'declined', 'cancelled'].includes(quote.status)) return res.status(400).json({ error: `Cannot reassign a quotation that is already ${quote.status}` });
    const { rows: [newEmp] } = await db.execute({ sql: 'SELECT id FROM employees WHERE id = ? AND active = 1', args: [employee_id] });
    if (!newEmp) return res.status(400).json({ error: 'Employee not found or inactive' });
    // First reassignment establishes original_employee_id from whatever
    // employee_id already was; subsequent reassignments leave it untouched
    // so credit always traces back to the very first salesperson, not
    // whoever it was most recently handed off from.
    const originalEmployeeId = quote.original_employee_id || quote.employee_id;
    await db.execute({ sql: 'UPDATE quotations SET employee_id = ?, original_employee_id = ? WHERE id = ?', args: [employee_id, originalEmployeeId, quote.id] });
    const { rows: [row] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name, e.first_name || ' ' || e.last_name as employee_name, oe.first_name || ' ' || oe.last_name as original_employee_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN employees e ON q.employee_id = e.id LEFT JOIN employees oe ON q.original_employee_id = oe.id WHERE q.id = ?`, args: [quote.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Special Projects: internal pricing approval ───────────────────────────
// A Special Project can't be sent to the customer or converted straight from
// Draft — a supervisor has to sign off on the pricing first. This is
// deliberately separate from the customer's own accept/decline (the existing
// status flow below), which still applies once a project is Approved.

router.patch('/:id/submit-for-approval', requirePermission('special_projects'), async (req, res) => {
  try {
    const { rows: [q] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!q) return res.status(404).json({ error: 'Not found' });
    if (q.quote_type !== 'special_project') return res.status(400).json({ error: 'Only Special Projects go through approval' });
    if (q.status !== 'draft') return res.status(400).json({ error: `This special project is ${q.status}, not a draft` });
    const { rows: [itemCount] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM quotation_items WHERE quote_id = ?', args: [req.params.id] });
    if (!Number(itemCount.c)) return res.status(400).json({ error: 'Add at least one line item before submitting for approval' });
    // Clears any earlier rejection so its banner doesn't linger on the
    // resubmitted project — mirrors PO's "resubmitted clears the old
    // rejection" pattern in PATCH /purchase-orders/:id/status.
    await db.execute({ sql: `UPDATE quotations SET status = 'pending_approval', submitted_at = CURRENT_TIMESTAMP, rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL WHERE id = ?`, args: [req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Signed with the approver's saved signature, or `signature` newly drawn
// (lib/signatures.js) — stamped on the quotation's print, email and PDF.
router.patch('/:id/approve', requirePermission('special_projects_approve'), async (req, res) => {
  try {
    const employee_id = req.employee?.id || req.body.employee_id || null;
    const { rows: [q] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!q) return res.status(404).json({ error: 'Not found' });
    if (q.status !== 'pending_approval') return res.status(400).json({ error: `This special project is ${q.status}, not awaiting approval` });
    let sigUrl;
    try { sigUrl = await resolveApprovalSignature(db, employee_id, req.body.signature); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }
    const tx = await db.transaction('write');
    let committed = false;
    try {
      await holdSpecialProjectRentals(tx, q, employee_id);
      await tx.execute({ sql: `UPDATE quotations SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_signature = ? WHERE id = ?`, args: [employee_id, sigUrl, req.params.id] });
      await tx.commit();
      committed = true;
    } catch(e) {
      if (!committed) await tx.rollback();
      return res.status(committed ? 500 : 400).json({ error: e.message });
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Same permission as approving, since it's the other half of the same
// decision — mirrors purchase_orders' reject-to-draft (routes/purchase-orders.js).
router.patch('/:id/reject', requirePermission('special_projects_approve'), async (req, res) => {
  try {
    const { reason, employee_id } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A rejection reason is required' });
    const { rows: [q] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!q) return res.status(404).json({ error: 'Not found' });
    if (q.status !== 'pending_approval') return res.status(400).json({ error: `This special project is ${q.status}, not awaiting approval` });
    await releaseSpecialProjectRentals(db, q.id, `Special Project ${q.quote_number} rejected`, employee_id);
    await db.execute({ sql: `UPDATE quotations SET status = 'draft', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_reason = ? WHERE id = ?`, args: [employee_id || null, reason.trim(), req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update quotation status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['draft', 'sent', 'accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows: [q] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!q) return res.status(404).json({ error: 'Not found' });
    if (q.status === 'converted') return res.status(400).json({ error: 'Cannot change status of converted quotation' });
    if (q.quote_type === 'special_project') {
      if (!req.apiKey && !can(req.employee && req.employee.permissions, 'special_projects')) return res.status(403).json({ error: 'Missing permission: special_projects' });
      if (status !== 'draft' && ['draft', 'pending_approval'].includes(q.status)) {
        return res.status(400).json({ error: 'This special project must be approved before it can be sent to the customer' });
      }
    }
    // Stamped only the first time a quote reaches that status — a quote
    // bounced back to draft and re-sent keeps its original sent_at, so the
    // Quote Funnel report's cycle time always measures from when it first
    // left Draft, not the most recent resend.
    const stampSent = status === 'sent' && !q.sent_at ? ', sent_at = CURRENT_TIMESTAMP' : '';
    const stampAccepted = status === 'accepted' && !q.accepted_at ? ', accepted_at = CURRENT_TIMESTAMP' : '';
    if (q.quote_type === 'special_project' && ['draft', 'declined'].includes(status)) {
      await releaseSpecialProjectRentals(db, q.id, `Special Project ${q.quote_number} ${status === 'draft' ? 'sent back to draft' : 'declined'}`, req.employee && req.employee.id);
    }
    await db.execute({ sql: `UPDATE quotations SET status = ?${stampSent}${stampAccepted} WHERE id = ?`, args: [status, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    // Customer has accepted the quote (their PO is in hand) — this is the
    // point custom "Q" items actually get submitted to Purchasing, grouped
    // into one PR for the whole quote rather than one per item. Rentals have
    // no Q-item/branch-transfer concept, so this is retail-only.
    if (status === 'accepted' && q.quote_type !== 'rental') await processQuoteAcceptance(row);
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Convert quotation to invoice — places it on hold for a cashier to pick up
// and actually collect payment on at the POS, rather than completing the
// sale here. Mirrors the shape of POST /transactions/hold (routes/transactions.js):
// status/payment_method='hold', no stock/loyalty/commission side effects —
// those only happen once a cashier finalizes the real checkout. The cashier
// recalls it via the normal Recall Held Order flow, which (via the existing
// `quote_id` passed through checkout) flips this quotation to 'converted'
// and repoints converted_to_tx at the real completed transaction.
router.post('/:id/convert', async (req, res) => {
  try {
    const { employee_id, branch_id } = req.body;
    const { rows: [quote] } = await db.execute({ sql: 'SELECT * FROM quotations WHERE id = ?', args: [req.params.id] });
    if (!quote) return res.status(404).json({ error: 'Quotation not found' });
    if (quote.status === 'converted') return res.status(400).json({ error: 'Already converted to invoice' });
    if (quote.status === 'declined') return res.status(400).json({ error: 'Cannot convert declined quotation' });
    if (quote.status === 'cancelled') return res.status(400).json({ error: 'Cannot convert cancelled quotation' });
    if (quote.quote_type === 'special_project') {
      if (!req.apiKey && !can(req.employee && req.employee.permissions, 'special_projects')) return res.status(403).json({ error: 'Missing permission: special_projects' });
      if (!['approved', 'sent', 'accepted'].includes(quote.status)) {
        return res.status(400).json({ error: 'This special project must be approved before it can be converted to an invoice' });
      }
    }

    // ORDER BY id so parent lines precede their accessory children — required
    // for revalidateQuoteLines' parent_item_id -> lines-index remap below.
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ? ORDER BY id', args: [quote.id] });
    if (!items.length) return res.status(400).json({ error: 'No items in quotation' });

    if (quote.quote_type === 'rental') {
      const targetBranchId = branch_id || quote.branch_id;
      if (!targetBranchId) return res.status(400).json({ error: 'A branch/location is required to convert this rental quote' });
      if (!quote.due_date) return res.status(400).json({ error: 'This rental quote has no due date set' });
      if (!quote.customer_id) return res.status(400).json({ error: 'A customer is required to convert this rental quote' });
      if (quote.delivery_required && !String(quote.delivery_address || '').trim()) return res.status(400).json({ error: 'This quote includes delivery but has no delivery address — edit the quote and enter where it\'s going (ask the customer) before converting' });
      if (quote.pickup_required && !String(quote.pickup_address || '').trim()) return res.status(400).json({ error: 'This quote includes pickup but has no pickup address — edit the quote and enter where it\'s being collected from (ask the customer) before converting' });

      // Only gates converting to a real agreement — the quote itself (and any
      // already-converted agreement) is untouched by this rule.
      try {
        const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [quote.customer_id] });
        assertRentalCustomerEligible(customer);
        await assertNoUnpaidRentalReturns(db, customer);
      } catch(e) { return res.status(400).json({ error: e.message }); }

      // Stock may have shifted since the quote was drafted — re-check now.
      // Unlike retail, rentals have no PR/purchase fallback for an
      // uncoverable shortfall, so a stock conflict here is a hard failure.
      let lines;
      try {
        lines = await revalidateQuoteLines(db, { branch_id: targetBranchId, quotationItems: items });
      } catch(e) { return res.status(400).json({ error: e.message }); }

      const agreement_number = await nextNumber(db, 'rental_agreements', 'agreement_number', 'RA-', 6);
      const tx = await db.transaction('write');
      let committed = false;
      try {
        const agreementId = await insertPendingAgreement(tx, {
          agreement_number, customer_id: quote.customer_id, employee_id: employee_id || quote.employee_id || null,
          branch_id: targetBranchId, due_date: quote.due_date,
          notes: `Converted from quotation ${quote.quote_number}`, lines,
          delivery_required: quote.delivery_required, delivery_cost: quote.delivery_cost, delivery_address: quote.delivery_address,
          pickup_required: quote.pickup_required, pickup_cost: quote.pickup_cost, pickup_address: quote.pickup_address,
          operator_required: quote.operator_required, operator_fee: quote.operator_fee,
          discount_amount: quote.discount_amount, rate_plan: quote.rate_plan,
        });
        await tx.execute({ sql: 'UPDATE quotations SET status = ?, converted_to_agreement_id = ? WHERE id = ?', args: ['converted', agreementId, quote.id] });
        await tx.commit();
        committed = true;

        const { rows: [agreement] } = await db.execute({ sql: 'SELECT * FROM rental_agreements WHERE id = ?', args: [agreementId] });
        const { rows: agItems } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [agreementId] });
        agreement.items = agItems;
        return res.status(201).json(agreement);
      } catch(e) {
        // Once committed, the pending agreement is saved — rolling back a
        // closed transaction throws and would crash the process (unhandled
        // rejection), so only roll back if the commit itself never happened.
        if (!committed) await tx.rollback();
        return res.status(committed ? 500 : 400).json({ error: e.message });
      }
    }

    // Each rental line must still be held — its hold may have been cancelled
    // from the Rentals screen since approval.
    const holdNumbers = {};
    for (const item of items.filter(i => i.is_rental_line)) {
      const { rows: [ag] } = item.rental_agreement_id
        ? await db.execute({ sql: 'SELECT agreement_number, status FROM rental_agreements WHERE id = ?', args: [item.rental_agreement_id] })
        : { rows: [] };
      if (!ag || ag.status !== 'pending') {
        return res.status(400).json({ error: `The rental hold for "${item.product_name}" is no longer in place. Send the project back to Draft and approve it again to re-hold the item.` });
      }
      holdNumbers[item.id] = ag.agreement_number;
    }

    const hold_number = 'HOLD-' + Date.now();

    const convTx = await db.transaction('write');
    let committed = false;
    try {
      const result = await convTx.execute({ sql: 'INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,payment_method,status,amount_tendered,change_amount,notes,po_number) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?)', args: [hold_number, quote.customer_id, employee_id||quote.employee_id||1, branch_id||quote.branch_id||null, quote.subtotal, quote.tax_amount, quote.discount_amount, quote.total, 'hold', 'hold', `Converted from quotation ${quote.quote_number}`, quote.po_number || null] });
      const txId = Number(result.lastInsertRowid);

      for (const item of items) {
        // A rental line goes on the invoice as a custom (no product) line so
        // the sale doesn't touch the rental fleet's stock — the item itself
        // goes out through its rental agreement.
        const isRental = !!item.is_rental_line;
        const name = isRental && !item.is_mandatory ? `${item.product_name} — ${holdNumbers[item.id]}` : item.product_name;
        await convTx.execute({ sql: 'INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,serial_number,sell_unit,units_per,uom_id,is_comment,is_delivery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [txId, isRental ? null : item.product_id, name, isRental ? 'RENTAL' : (item.sku || ''), item.quantity, item.unit_price, item.discount_amount, item.tax_amount, item.total, item.serial_number || null, isRental ? null : (item.sell_unit || null), isRental ? 1 : (item.units_per || 1), isRental ? null : (item.uom_id ?? null), item.is_comment ? 1 : 0, item.is_delivery ? 1 : 0] });
      }

      await convTx.execute({ sql: 'UPDATE quotations SET status = ?, converted_to_tx = ? WHERE id = ?', args: ['converted', txId, quote.id] });
      await convTx.commit();
      committed = true;

      const { rows: [savedTx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id WHERE t.id = ?`, args: [txId] });
      const { rows: txItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [txId] });
      savedTx.items = txItems;

      // Converting straight to an invoice (skipping an explicit "Accept") is
      // still the customer saying yes — make sure any Q items/shortfalls get flagged.
      await processQuoteAcceptance(quote);
      res.status(201).json(savedTx);
    } catch(e) {
      // Once committed, the hold is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await convTx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Attachments ──────────────────────────────────────────────
// Supporting documents (customer PO, supplier quote, drawings/specs) on any
// quotation, Special Projects included. Mirrors the PO attachment routes in
// routes/purchase-orders.js. On a Special Project, viewing/downloading
// follows the same rule as GET /:id (special_projects or
// special_projects_approve); adding/removing needs special_projects.

const localUploadDir = path.join(__dirname, '../uploads/quote-attachments');
const QUOTE_DOC_TYPES = ['customer_po', 'supplier_quotation', 'specification', 'other'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/gif','image/webp',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Loads the quote and enforces Special Project visibility/edit rights.
// Sends the error response itself and returns null when access is denied.
async function quoteForAttachments(req, res, write) {
  const { rows: [quote] } = await db.execute({ sql: 'SELECT id, quote_type FROM quotations WHERE id = ?', args: [req.params.id] });
  if (!quote) { res.status(404).json({ error: 'Not found' }); return null; }
  if (quote.quote_type === 'special_project') {
    if (!canSeeSpecialProjects(req)) { res.status(403).json({ error: 'Missing permission: special_projects' }); return null; }
    if (write && !can(req.employee && req.employee.permissions, 'special_projects')) { res.status(403).json({ error: 'Missing permission: special_projects' }); return null; }
  }
  return quote;
}

router.get('/:id/attachments', async (req, res) => {
  try {
    if (!await quoteForAttachments(req, res, false)) return;
    const { rows } = await db.execute({ sql: `SELECT qa.*, e.first_name || ' ' || e.last_name as uploaded_by_name FROM quote_attachments qa LEFT JOIN employees e ON qa.uploaded_by = e.id WHERE qa.quote_id = ? ORDER BY qa.uploaded_at DESC`, args: [req.params.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/attachments', (req, res, next) => {
  // Surface multer's size-limit error as a 400 instead of Express's HTML 500.
  upload.single('file')(req, res, err => err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB' : err.message }) : next());
}, async (req, res) => {
  try {
    const quote = await quoteForAttachments(req, res, true);
    if (!quote) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded or file type not allowed' });
    const docType = QUOTE_DOC_TYPES.includes(req.body.document_type) ? req.body.document_type : 'other';

    const cloudResult = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/quote-attachments',
      public_id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      resource_type: 'auto',
    });

    let storedName;
    if (cloudResult) {
      storedName = cloudResult.secure_url;
    } else {
      fs.mkdirSync(localUploadDir, { recursive: true });
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      storedName = `${unique}${path.extname(req.file.originalname)}`;
      fs.writeFileSync(path.join(localUploadDir, storedName), req.file.buffer);
    }

    const result = await db.execute({ sql: 'INSERT INTO quote_attachments (quote_id, document_type, original_name, stored_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?)', args: [quote.id, docType, req.file.originalname, storedName, req.file.mimetype, req.file.size, (req.employee && req.employee.id) || null] });
    const { rows: [row] } = await db.execute({ sql: `SELECT qa.*, e.first_name || ' ' || e.last_name as uploaded_by_name FROM quote_attachments qa LEFT JOIN employees e ON qa.uploaded_by = e.id WHERE qa.id = ?`, args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/attachments/:aid/download', async (req, res) => {
  try {
    if (!await quoteForAttachments(req, res, false)) return;
    const { rows: [att] } = await db.execute({ sql: 'SELECT * FROM quote_attachments WHERE id = ? AND quote_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.stored_name.startsWith('https://')) {
      // Cloud file — redirect with fl_attachment to force browser download
      return res.redirect(att.stored_name.replace('/upload/', '/upload/fl_attachment/'));
    }
    const filePath = path.join(localUploadDir, att.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on server' });
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.attachment(att.original_name);
    res.sendFile(filePath);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/attachments/:aid', async (req, res) => {
  try {
    if (!await quoteForAttachments(req, res, true)) return;
    const { rows: [att] } = await db.execute({ sql: 'SELECT * FROM quote_attachments WHERE id = ? AND quote_id = ?', args: [req.params.aid, req.params.id] });
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.stored_name.startsWith('https://')) {
      // resource_type 'auto' files PDFs/images under image/, Office docs under
      // raw/ — read it back from the URL rather than guessing from the mime.
      const resourceType = (att.stored_name.match(/\/(image|raw|video)\/upload\//) || [])[1] || 'raw';
      await cloudDestroy(att.stored_name, resourceType);
    } else {
      try { if (fs.existsSync(path.join(localUploadDir, att.stored_name))) fs.unlinkSync(path.join(localUploadDir, att.stored_name)); } catch(e) {}
    }
    await db.execute({ sql: 'DELETE FROM quote_attachments WHERE id = ?', args: [att.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
