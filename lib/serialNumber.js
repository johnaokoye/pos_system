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

module.exports = { SERIAL_NUMBER_SKU, isSerialNumberProduct, serialNumberLabel, serialNumberOf };
