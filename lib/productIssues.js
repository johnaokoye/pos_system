// Shared "data quality" checks — one source of truth for both the general
// Inventory "Export Missing Data" and the per-import-batch review, matching
// the ad-hoc checks used to review the 2026-09-02 bulk import (zero price
// despite real cost, negative stock, missing category/supplier/barcode).
const HAS_ISSUE_SQL = `(p.price = 0 OR p.stock_qty < 0 OR p.category_id IS NULL OR p.supplier_id IS NULL OR p.barcode IS NULL)`;

const ISSUE_LABEL_SQL = `TRIM(
  (CASE WHEN p.price = 0 AND p.cost > 0 THEN 'zero_price_with_cost;' ELSE '' END) ||
  (CASE WHEN p.price = 0 AND p.cost = 0 THEN 'zero_price_and_cost;' ELSE '' END) ||
  (CASE WHEN p.stock_qty < 0 THEN 'negative_stock;' ELSE '' END) ||
  (CASE WHEN p.category_id IS NULL THEN 'missing_category;' ELSE '' END) ||
  (CASE WHEN p.supplier_id IS NULL THEN 'missing_supplier;' ELSE '' END) ||
  (CASE WHEN p.barcode IS NULL THEN 'missing_barcode;' ELSE '' END)
, ';')`;

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows, headers) {
  const csvRows = [headers.join(',')];
  for (const r of rows) csvRows.push(headers.map(h => csvEscape(r[h])).join(','));
  return csvRows.join('\n');
}

module.exports = { HAS_ISSUE_SQL, ISSUE_LABEL_SQL, csvEscape, rowsToCsv };
