// Purchase order line pricing: quantity × unit cost, less the vendor's
// discount on that line, then tax on what's left — either the store's local
// sales tax (GCT, the `tax_rate` setting, snapshotted onto the line so a
// later rate change doesn't rewrite an existing PO) or none, for overseas
// vendors who don't charge it. purchase_order_items.total is the line AFTER
// the vendor discount and before tax; purchase_orders.subtotal is the sum of
// those, tax_amount the sum of line tax, total = subtotal + tax_amount.
//
// (purchase_order_items.discount_amount is a different thing — the
// customer-facing discount carried over from a quote line, for reference
// only. The vendor's discount is vendor_discount.)
const { getSetting } = require('./settings');

const TAX_OPTIONS = ['local', 'none'];
const round2 = n => parseFloat((Number(n) || 0).toFixed(2));

async function localTaxRate() {
  return parseFloat(await getSetting('tax_rate', 0)) || 0;
}

// New lines default to the vendor: GCT for a supplier flagged Local, no tax otherwise.
const defaultTaxOption = supplier => (supplier && supplier.is_local ? 'local' : 'none');

// The vendor discount is either dollars off the line (vendor_discount) or a
// percentage of it (vendor_discount_percent, 0-100) — a percentage wins when
// both are given, and is kept so the discount follows qty/cost edits.
// Throws a user-facing Error for a bad discount or tax option.
function priceLine({ name, quantity, unit_cost, vendor_discount, vendor_discount_percent, tax_option }, taxRate) {
  // Part quantities are allowed for measured units (lib/units.js, e.g. 12.5 kg).
  const qty = Math.round((Number(quantity) || 1) * 1000) / 1000;
  const cost = parseFloat(unit_cost) || 0;
  const gross = round2(qty * cost);
  const hasPercent = vendor_discount_percent != null && vendor_discount_percent !== '';
  const percent = hasPercent ? parseFloat(vendor_discount_percent) : null;
  if (hasPercent && (!(percent >= 0) || percent > 100)) throw new Error(`The vendor discount on "${name || 'an item'}" must be between 0% and 100%`);
  const discount = hasPercent ? round2(gross * percent / 100) : round2(Math.max(0, parseFloat(vendor_discount) || 0));
  if (discount > gross) throw new Error(`The vendor discount on "${name || 'an item'}" (${discount.toFixed(2)}) is more than the line's cost (${gross.toFixed(2)})`);
  const option = tax_option || 'none';
  if (!TAX_OPTIONS.includes(option)) throw new Error('Tax must be local tax or no tax');
  const total = round2(gross - discount);
  const rate = option === 'local' ? taxRate : 0;
  return { quantity_ordered: qty, unit_cost: cost, vendor_discount: discount, vendor_discount_percent: hasPercent ? percent : null, total, tax_option: option, tax_rate: rate, tax_amount: round2(total * rate / 100) };
}

function poTotals(lines) {
  const subtotal = round2(lines.reduce((s, l) => s + l.total, 0));
  const tax_amount = round2(lines.reduce((s, l) => s + l.tax_amount, 0));
  return { subtotal, tax_amount, total: round2(subtotal + tax_amount) };
}

// Value of `qty` units of a line as billed — its share of the discounted line
// total plus its share of the line's tax.
function receivedValue(item, qty) {
  const ordered = Number(item.quantity_ordered) || 0;
  if (!ordered) return { goods: 0, tax: 0 };
  return { goods: (Number(item.total) || 0) * qty / ordered, tax: (Number(item.tax_amount) || 0) * qty / ordered };
}

module.exports = { TAX_OPTIONS, localTaxRate, defaultTaxOption, priceLine, poTotals, receivedValue, round2 };
