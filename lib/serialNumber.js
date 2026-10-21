// The "SN" catalog item (seeded in database.js) is a $0, no-stock service
// whose only job is to carry a serial number on a ticket or quotation —
// ring up the serialized item, then add SN right after it and key in the
// serial. Each SN line is its own row (never merged/quantity-bumped), named
// "SN: <serial>" so every receipt/quote/print template shows the serial
// without special-casing, with the raw value also kept in serial_number
// for lookups.
const SERIAL_NUMBER_SKU = 'SN';

function isSerialNumberProduct(product) {
  return !!product && String(product.sku || '').toUpperCase() === SERIAL_NUMBER_SKU;
}

function serialNumberLabel(serial) {
  return `SN: ${serial}`;
}

// Trimmed serial sent for an SN line, or '' when none was entered. Serials
// are optional — callers drop a blank SN line rather than refusing the sale
// or quote, since an SN line with no serial carries nothing.
function serialNumberOf(item) {
  return String(item.serial_number || '').trim();
}

// A serial that's really an item number — a cashier keying or scanning the
// product's own code at the serial prompt (e.g. "FA0302" for the item
// FA0302) records nothing useful. Returns an error message when `serial`
// matches any product's item number or barcode, else null.
async function serialClashError(db, serial) {
  const { rows: [p] } = await db.execute({
    sql: "SELECT name, sku FROM products WHERE (lower(sku) = lower(?) OR lower(barcode) = lower(?)) AND upper(COALESCE(sku, '')) != ? LIMIT 1",
    args: [serial, serial, SERIAL_NUMBER_SKU],
  });
  return p ? `"${serial}" is the item number for ${p.name}, not a serial number — enter the serial printed on the product` : null;
}

module.exports = { SERIAL_NUMBER_SKU, isSerialNumberProduct, serialNumberLabel, serialNumberOf, serialClashError };
