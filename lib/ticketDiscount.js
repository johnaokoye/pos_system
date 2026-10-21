// Ticket-level discounts (the POS Ticket Discount $, a promo code, an
// auto-applied promotion, a discount card, a quote's Discount) come off
// BEFORE tax: the discount is spread over the lines in proportion to each
// line's net amount (after any line "%" discount) and each line is taxed on
// what's left. So a $100 discount on $1,000 at 15% GCT charges
// $900 + $135 = $1,035, not $1,000 + $150 − $100.
//
// A return credit applied to an exchange (source_return_id) is NOT a
// discount — it's money the customer already paid, tax included — so it
// still comes off after tax, like store credit and cash back.
//
// The POS cart (App._allocateTicketDiscount in public/index.html) uses the
// same split so the screen shows exactly what checkout charges.

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// amounts: each line's net amount. Returns { discount, shares } — the
// discount capped at the lines' total, and each line's share of it, rounded
// to cents with the last line that has an amount taking the remainder so the
// shares always add up to exactly `discount`.
function allocateTicketDiscount(amounts, discount) {
  const nets = amounts.map(a => Math.max(0, Number(a) || 0));
  const base = r2(nets.reduce((s, a) => s + a, 0));
  const disc = r2(Math.min(Math.max(0, Number(discount) || 0), base));
  const shares = nets.map(() => 0);
  if (!(disc > 0)) return { discount: 0, shares };
  let last = -1;
  nets.forEach((a, i) => { if (a > 0) last = i; });
  let given = 0;
  nets.forEach((a, i) => {
    if (!(a > 0) || i === last) return;
    shares[i] = r2(disc * a / base);
    given = r2(given + shares[i]);
  });
  shares[last] = r2(disc - given);
  return { discount: disc, shares };
}

// A returned line's share of the sale's ticket discount, for `proportion` of
// its quantity. Sales since the discount moved before tax store each line's
// share (transaction_items.ticket_discount); older sales took the discount
// off after tax and stored no split, so it's spread by line total — either
// way a full return refunds what the customer actually paid. Exchanges paid
// with a return credit aren't discounted, so nothing comes off.
function returnedDiscountShare(tx, txItem, allItems, proportion) {
  if (txItem.ticket_discount != null) return r2(txItem.ticket_discount * proportion);
  const disc = Number(tx.discount_amount) || 0;
  if (!(disc > 0) || tx.source_return_id) return 0;
  const { shares } = allocateTicketDiscount(allItems.map(i => i.total), disc);
  const idx = allItems.findIndex(i => i.id === txItem.id);
  return r2((shares[idx] || 0) * proportion);
}

module.exports = { allocateTicketDiscount, returnedDiscountShare };
