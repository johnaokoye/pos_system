// Special Project custom lines: Item No. (sku), U.O.M (sell_unit), Rent Period
// and a discount taken off the line. Extended price is quantity × period ×
// unit price; quotation_items.total is what's left after the discount.

const money = n => (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const RENT_PERIOD_UNITS = ['Hour(s)', 'Day(s)', 'Week(s)', 'Month(s)'];

function lineExtended(i) {
  return parseFloat(((parseFloat(i.unit_price) || 0) * (parseFloat(i.quantity) || 0) * (i.rent_period != null ? parseFloat(i.rent_period) : 1)).toFixed(2));
}

// "25.00 Day(s)", or '' for a line with no rent period.
function rentPeriodLabel(i) {
  return i.rent_period != null ? `${money(i.rent_period)} ${i.rent_period_unit || RENT_PERIOD_UNITS[1]}` : '';
}

// "Less discount (10%): -$10,270.13", or '' when none was taken off the line.
// A line whose discount was only recorded for reference has discount_applied = 0.
function lineDiscountLabel(i) {
  if (!i.discount_applied || !(parseFloat(i.discount_amount) > 0)) return '';
  const pct = i.discount_percent != null ? ` (${parseFloat(i.discount_percent)}%)` : '';
  return `Less discount${pct}: -$${money(i.discount_amount)}`;
}

// A document's totals: Subtotal before any discount, Discount = the lines' plus
// the project's. q.subtotal is already net of the lines' discounts.
function quoteDocTotals(q) {
  const lineDiscounts = (q.items || []).reduce((sum, i) => sum + (i.discount_applied ? parseFloat(i.discount_amount) || 0 : 0), 0);
  return {
    subtotal: parseFloat(((parseFloat(q.subtotal) || 0) + lineDiscounts).toFixed(2)),
    discount: parseFloat(((parseFloat(q.discount_amount) || 0) + lineDiscounts).toFixed(2)),
  };
}

// What a Special Project's quotation says while it isn't approved yet, or null.
function quoteDraftLabel(q) {
  if (q.quote_type !== 'special_project') return null;
  if (q.status === 'draft') return 'DRAFT';
  if (q.status === 'pending_approval') return 'DRAFT - PENDING APPROVAL';
  return null;
}

// How a quote line goes onto a POS ticket. The POS recalculates a custom line as
// whole quantity × price, so a line using these fields goes on as one line at
// its exact total, with the detail in its name. Any other line is unchanged.
function quoteLineForSale(i) {
  const usesFields = !i.product_id && i.is_temp_item && !i.is_q_item
    && (i.rent_period != null || i.discount_applied || i.sku || i.sell_unit || !Number.isInteger(Number(i.quantity)));
  if (!usesFields) return { name: i.product_name, quantity: i.quantity, unit_price: i.unit_price, packed: false };
  const qty = `${money(i.quantity)}${i.sell_unit ? ` ${i.sell_unit}` : ''}`;
  const period = i.rent_period != null ? ` x ${rentPeriodLabel(i)}` : '';
  const discount = lineDiscountLabel(i);
  return {
    name: `${i.sku ? `${i.sku} ` : ''}${i.product_name} - ${qty}${period} @ $${money(i.unit_price)}${discount ? `, ${discount.charAt(0).toLowerCase()}${discount.slice(1)}` : ''}`,
    quantity: 1,
    unit_price: parseFloat(i.total) || 0,
    packed: true,
  };
}

module.exports = { RENT_PERIOD_UNITS, lineExtended, rentPeriodLabel, lineDiscountLabel, quoteDocTotals, quoteDraftLabel, quoteLineForSale };
