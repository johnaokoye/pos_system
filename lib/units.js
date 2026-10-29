// Units of measure. Each product has one stock unit (products.base_unit_id →
// units_of_measure; NULL means "Each") and can also be sold, quoted, ordered
// and put on layaway in alternate units (product_units): each is worth
// `factor` stock units and has its own price and barcode — e.g. rope stocked
// by the foot and sold by the yard (factor 3), or water stocked as singles
// and sold by the case (factor 24).
//
// A line's quantity and price are in its own unit, and units_per (the factor,
// copied onto the line when it's created) converts it to stock units, so
// stock moves quantity × units_per and a later change to the factor doesn't
// change what an old sale, return or receipt moved. Units marked
// allow_decimal (yards, kilograms…) take fractional quantities.

const EACH = { id: null, name: 'Each', abbreviation: 'ea', allow_decimal: 0 };

// A product's alternate units, cheapest-factor first.
async function productUnits(db, productId) {
  const { rows } = await db.execute({ sql: `SELECT pu.unit_id, pu.factor, pu.price, pu.barcode, u.name, u.abbreviation, u.allow_decimal
    FROM product_units pu JOIN units_of_measure u ON u.id = pu.unit_id
    WHERE pu.product_id = ? ORDER BY pu.factor, u.name`, args: [productId] });
  return rows;
}

// Every product's alternate units, keyed by product id (for list endpoints).
async function unitsByProduct(db) {
  const { rows } = await db.execute({ sql: `SELECT pu.product_id, pu.unit_id, pu.factor, pu.price, pu.barcode, u.name, u.abbreviation, u.allow_decimal
    FROM product_units pu JOIN units_of_measure u ON u.id = pu.unit_id ORDER BY pu.factor, u.name`, args: [] });
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.product_id)) map.set(r.product_id, []);
    map.get(r.product_id).push(r);
  }
  return map;
}

async function baseUnit(db, product) {
  if (!product?.base_unit_id) return EACH;
  const { rows: [u] } = await db.execute({ sql: 'SELECT id, name, abbreviation, allow_decimal FROM units_of_measure WHERE id = ?', args: [product.base_unit_id] });
  return u || EACH;
}

// "Case of 24" for a counted pack, plain "Yard" for a measure.
function unitLabel(u) {
  const f = Number(u.factor);
  return !u.allow_decimal && Number.isInteger(f) && f > 1 ? `${u.name} of ${f}` : u.name;
}

// Finds the requested alternate unit: a unit id, or the legacy 'case'
// (from before units, when a case was the only alternative).
function findUnit(units, requested) {
  if (requested === 'case') return units.find(u => u.name.toLowerCase() === 'case');
  return units.find(u => String(u.unit_id) === String(requested));
}

const isBase = (product, requested) => requested == null || requested === '' || (product.base_unit_id && String(requested) === String(product.base_unit_id));

// The unit a sale/quote/layaway line is sold in:
// { uom_id, sell_unit, units_per, price, label, allow_decimal }. Throws a
// user-facing Error if the product isn't sold in that unit. sell_unit and
// label stay null for a plain Each line so its name isn't decorated.
async function resolveUnit(db, product, requested) {
  const base = await baseUnit(db, product);
  if (product.is_service || product.is_rental || isBase(product, requested)) {
    // A plain Each item keeps accepting whatever quantity it always did (a
    // service billed for 1.5 hours); only a named unit enforces its rule.
    return { uom_id: base.id, sell_unit: base.id ? base.name : null, units_per: 1, price: product.price, label: base.id ? base.name : null, allow_decimal: base.id ? base.allow_decimal : 1 };
  }
  const u = findUnit(await productUnits(db, product.id), requested);
  if (!u) throw new Error(`${product.name} isn't sold in that unit`);
  if (!(Number(u.price) > 0)) throw new Error(`${product.name} has no ${u.name} price — set it on the product first`);
  return { uom_id: u.unit_id, sell_unit: u.name, units_per: Number(u.factor), price: Number(u.price), label: unitLabel(u), allow_decimal: u.allow_decimal };
}

// The unit a purchase-order line is ordered in — only needs the conversion,
// not a selling price. { uom_id, purchase_unit, units_per, label, allow_decimal }.
async function resolvePurchaseUnit(db, product, requested) {
  if (!product) return { uom_id: null, purchase_unit: null, units_per: 1, label: null, allow_decimal: 0 };
  const base = await baseUnit(db, product);
  if (isBase(product, requested)) return { uom_id: base.id, purchase_unit: base.id ? base.name : null, units_per: 1, label: base.id ? base.name : null, allow_decimal: base.allow_decimal };
  const u = findUnit(await productUnits(db, product.id), requested);
  if (!u) throw new Error(`${product.name} has no such unit — add it with + Add unit… on the line, or on the product form`);
  return { uom_id: u.unit_id, purchase_unit: u.name, units_per: Number(u.factor), label: unitLabel(u), allow_decimal: u.allow_decimal };
}

// Line name as shown on receipts, quotes, history and reports.
function lineName(name, unit) {
  return unit?.label ? `${name} (${unit.label})` : name;
}

// A purchase request / PO line split for a document's Item and Unit
// columns: { name, unit } — the name without the "(Case of 24)" lineName()
// added, and the unit it's ordered in ("Case of 24", "Yard", "Each"; "—"
// for a service). Lines from before units show Each.
function orderLineUnit(line) {
  const name = String(line.product_name || '');
  if (line.item_type === 'service') return { name, unit: '—' };
  const per = Number(line.units_per) || 1;
  const m = line.purchase_unit ? name.match(/^(.*) \(([^()]*)\)$/) : null;
  if (m && m[2].toLowerCase().startsWith(String(line.purchase_unit).toLowerCase())) return { name: m[1], unit: m[2] };
  if (!line.purchase_unit) return { name, unit: 'Each' };
  return { name, unit: Number.isInteger(per) && per > 1 ? `${line.purchase_unit} of ${per}` : line.purchase_unit };
}

// A line quantity in its unit: whole numbers unless the unit allows
// decimals (rounded to 3 places). Returns NaN for anything else.
function parseQty(raw, allowDecimal) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  if (allowDecimal) return Math.round(n * 1000) / 1000;
  return Number.isInteger(n) ? n : NaN;
}

// Stock units a line moves (rounded so 2.5 yd × 3 is 7.5 ft, not 7.499999…).
const stockUnits = (quantity, unitsPer) => Math.round((Number(quantity) || 0) * (Number(unitsPer) || 1) * 10000) / 10000;

module.exports = { EACH, productUnits, unitsByProduct, baseUnit, unitLabel, resolveUnit, resolvePurchaseUnit, lineName, orderLineUnit, parseQty, stockUnits };
