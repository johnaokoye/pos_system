// Selling a retail item by the case (products.case_qty / case_price /
// case_barcode). Stock is always counted in singles: a line's quantity is in
// its own unit (cases or singles) and units_per says how many singles one of
// those is, so stock moves quantity × units_per. units_per is copied onto the
// line when it's created, so changing a product's case size later doesn't
// change what an old sale, return or receipt moved.

const CASE = 'case';

// Whether a product is set up to sell by the case.
function sellsByCase(product) {
  return !!product && !product.is_service && !product.is_rental && (Number(product.case_qty) || 0) > 1 && (Number(product.case_price) || 0) > 0;
}

// { sell_unit, units_per, price, label } for a requested unit, or throws a
// user-facing Error if the product can't be sold that way.
function resolveUnit(product, requestedUnit) {
  if (requestedUnit !== CASE) return { sell_unit: null, units_per: 1, price: product.price, label: null };
  if (!sellsByCase(product)) throw new Error(`${product.name} isn't sold by the case`);
  const units = Number(product.case_qty);
  return { sell_unit: CASE, units_per: units, price: Number(product.case_price), label: caseLabel(units) };
}

const caseLabel = units => `Case of ${units}`;

// Buying by the case only needs a case size — a product doesn't have to be
// sold by the case to be ordered that way. { purchase_unit, units_per }.
function resolvePurchaseUnit(product, requestedUnit) {
  if (requestedUnit !== CASE || !product) return { purchase_unit: null, units_per: 1 };
  const units = Number(product.case_qty) || 0;
  if (units <= 1) throw new Error(`${product.name} has no case size set — set "Singles per Case" on the product first`);
  return { purchase_unit: CASE, units_per: units };
}

// Line name as shown on receipts, quotes, history and reports.
function lineName(name, unit) {
  return unit?.sell_unit === CASE ? `${name} (${unit.label})` : name;
}

// Singles a line moves.
const stockUnits = (quantity, unitsPer) => (Number(quantity) || 0) * (Number(unitsPer) || 1);

module.exports = { CASE, sellsByCase, resolveUnit, resolvePurchaseUnit, caseLabel, lineName, stockUnits };
