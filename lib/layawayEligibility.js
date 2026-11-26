// Which items can go on layaway (owner's rule, 2026-11-26; Settings → Layaway):
//   layaway_min_price      — an item priced below this is never eligible (0 = no minimum)
//   layaway_auto_eligible  — '1': every retail item priced at or above the
//                            minimum is eligible without ticking it
// Otherwise an item needs its own "Eligible for Layaway" box ticked
// (products.is_layaway_eligible). Rentals and services never are. The price
// is the item's own (stock unit) price.
const { getSetting } = require('./settings');

async function layawayRules(db) {
  const minPrice = Math.max(0, parseFloat(await getSetting('layaway_min_price', 0)) || 0);
  const auto = String(await getSetting('layaway_auto_eligible', '0')) === '1';
  return { minPrice, auto };
}

// SQL condition over products (alias p) for an eligible item.
function layawayEligibleSql(rules, alias = 'p') {
  const parts = [`COALESCE(${alias}.is_rental, 0) = 0`, `COALESCE(${alias}.is_service, 0) = 0`];
  if (!rules.auto) parts.push(`${alias}.is_layaway_eligible = 1`);
  if (rules.minPrice > 0) parts.push(`COALESCE(${alias}.price, 0) >= ${Number(rules.minPrice)}`);
  return `(${parts.join(' AND ')})`;
}

// Why a product can't go on layaway, or null when it can.
function layawayIneligibleReason(product, rules) {
  if (product.is_rental || product.is_service) return `${product.name} is not eligible for layaway`;
  if (rules.minPrice > 0 && (Number(product.price) || 0) < rules.minPrice - 0.005) {
    return `${product.name} is priced below the layaway minimum of ${rules.minPrice.toFixed(2)}`;
  }
  if (!rules.auto && !product.is_layaway_eligible) return `${product.name} is not eligible for layaway`;
  return null;
}

module.exports = { layawayRules, layawayEligibleSql, layawayIneligibleReason };
