// A rental item and a retail item may share a SKU: products.sku is unique per
// kind (UNIQUE INDEX idx_products_sku_kind on (sku, is_rental)), not overall.
// Rental Items and Inventory are kept as separate catalogues, so the same
// supplier code can be both a ladder for sale and a ladder for hire. Barcodes
// stay unique across everything (products.barcode UNIQUE), because the POS
// scans them.
//
// Both helpers below run once from database.js _init().

// Older databases declared `sku TEXT UNIQUE`, which SQLite can't drop in
// place, so the table is rebuilt from its own CREATE statement minus that
// UNIQUE. Done through db.migrate(): foreign keys are switched off for it,
// because dropping the old products table with them on would fire every
// child table's ON DELETE action (e.g. null product_import_batch_items).
async function relaxProductSkuUnique(db) {
  const { rows: [t] } = await db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'");
  if (t && /\bsku\s+TEXT\s+UNIQUE\b/i.test(t.sql)) {
    const createNew = t.sql
      .replace(/\bsku\s+TEXT\s+UNIQUE\s+NOT\s+NULL\b/i, 'sku TEXT NOT NULL')
      .replace(/^CREATE TABLE\s+"?products"?\s*\(/i, 'CREATE TABLE products_new (');
    if (/\bsku\s+TEXT\s+UNIQUE\b/i.test(createNew) || !/^CREATE TABLE products_new \(/.test(createNew)) {
      throw new Error('products schema not in the expected shape; SKU rule left unchanged');
    }
    // Indexes are dropped with the table: recreate the named ones after.
    const { rows: idx } = await db.execute("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'products' AND sql IS NOT NULL");
    // AUTOINCREMENT's high-water mark lives in sqlite_sequence; keep it so a
    // deleted product's id is never handed out again.
    const { rows: [seq] } = await db.execute("SELECT seq FROM sqlite_sequence WHERE name = 'products'");
    const { rows: [{ n: before }] } = await db.execute('SELECT COUNT(*) AS n FROM products');
    await db.migrate([
      { sql: createNew, args: [] },
      { sql: 'INSERT INTO products_new SELECT * FROM products', args: [] },
      { sql: 'DROP TABLE products', args: [] },
      { sql: 'ALTER TABLE products_new RENAME TO products', args: [] },
      ...idx.map(i => ({ sql: i.sql, args: [] })),
      ...(seq ? [{ sql: "UPDATE sqlite_sequence SET seq = ? WHERE name = 'products' AND seq < ?", args: [seq.seq, seq.seq] }] : []),
    ]);
    const { rows: [{ n: after }] } = await db.execute('SELECT COUNT(*) AS n FROM products');
    console.log(`[products] SKU now unique per kind (retail / rental); ${after} of ${before} items carried over`);
  }
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_kind ON products(sku, is_rental)');
}

const RETAIL_FIELDS = ['name', 'description', 'long_description', 'category_id', 'tax_rate', 'min_stock', 'active'];
const LEFTOVER_FIELDS = ['price', 'cost', 'barcode', 'supplier_id'];

// Before SKUs were split by kind, the retail import (POST /products/import)
// matched a rental item with the same SKU and wrote the retail item's details
// over it, leaving it a rental, so the retail item never existed. The import
// logged the rental item as it was just before (product_import_batch_items
// .previous_values, is_rental = 1); that snapshot and the later ones are how
// such an item is found and taken apart:
//  - the rental item keeps its id (rental agreements, counts and transfers
//    stay on it) and gets back its own price, cost, barcode and supplier,
//    which a later rental re-import never resets; if no rental re-import has
//    put back its name either, its name and details come back too;
//  - a retail item is created with the same SKU from the retail details the
//    import wrote (taken from the snapshot the next import made, else the
//    item as it is now) and the current price, cost, barcode and supplier.
//    Stock starts at 0, since the stock on the row is the rental's again.
//    When staff already made the retail item under a differently-cased SKU
//    (fles210 for FLES210) none is created; that item is noted instead.
// Every item handled is logged in product_kind_splits, which also keeps it
// from being handled twice.
async function splitRetailFromRentalImports(db) {
  const { rows: candidates } = await db.execute(`
    SELECT p.* FROM products p
    WHERE p.is_rental = 1
      AND NOT EXISTS (SELECT 1 FROM product_kind_splits s WHERE s.rental_product_id = p.id)
      AND EXISTS (SELECT 1 FROM product_import_batch_items i JOIN product_import_batches b ON b.id = i.batch_id
                  WHERE i.product_id = p.id AND i.action = 'updated' AND b.status <> 'reversed'
                    AND json_extract(i.previous_values, '$.is_rental') = 1)
    ORDER BY p.id`);
  let split = 0, existing = 0;
  for (const cur of candidates) {
    const { rows: snaps } = await db.execute({
      sql: `SELECT i.previous_values FROM product_import_batch_items i JOIN product_import_batches b ON b.id = i.batch_id
            WHERE i.product_id = ? AND i.action = 'updated' AND b.status <> 'reversed'
              AND json_extract(i.previous_values, '$.is_rental') = 1
            ORDER BY i.id`,
      args: [cur.id],
    });
    const parsed = snaps.map(s => JSON.parse(s.previous_values));
    const rental = parsed[0];
    const retailSnap = parsed.slice(1).reverse().find(s => s.name !== rental.name) || null;
    const retailSrc = retailSnap || cur;

    // Rental side: what the retail import wrote and nothing has put back.
    const rentalSet = {};
    for (const f of LEFTOVER_FIELDS) rentalSet[f] = rental[f] ?? null;
    if (cur.rental_allow_sale) delete rentalSet.price; // its own sale price
    if (retailSnap && cur.name === retailSnap.name) {
      for (const f of RETAIL_FIELDS) if (f in rental) rentalSet[f] = rental[f];
    }

    const { rows: [twin] } = await db.execute({
      sql: 'SELECT id, sku, name FROM products WHERE is_rental = 0 AND LOWER(TRIM(sku)) = LOWER(TRIM(?)) ORDER BY (sku = ?) DESC, id LIMIT 1',
      args: [cur.sku, cur.sku],
    });

    const tx = await db.transaction('write');
    try {
      const cols = Object.keys(rentalSet);
      await tx.execute({ sql: `UPDATE products SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, args: [...cols.map(c => rentalSet[c]), cur.id] });
      let retailId = null;
      if (!twin) {
        const pick = f => (cur[f] != null && cur[f] !== 0 ? cur[f] : retailSrc[f] ?? null);
        const barcode = pick('barcode');
        const r = await tx.execute({
          sql: `INSERT INTO products (sku, barcode, name, description, long_description, category_id, price, cost, tax_rate, stock_qty, min_stock, active, supplier_id, is_rental)
                VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,0)`,
          args: [cur.sku, barcode === rentalSet.barcode ? null : barcode, retailSrc.name, retailSrc.description ?? null, retailSrc.long_description ?? null,
            retailSrc.category_id ?? null, pick('price') || 0, pick('cost') || 0, retailSrc.tax_rate ?? cur.tax_rate, retailSrc.min_stock ?? 5,
            retailSrc.active ?? 1, pick('supplier_id')],
        });
        retailId = Number(r.lastInsertRowid);
      }
      await tx.execute({
        sql: `INSERT INTO product_kind_splits (rental_product_id, retail_product_id, sku, outcome, existing_retail_id, rental_before)
              VALUES (?,?,?,?,?,?)`,
        args: [cur.id, retailId, cur.sku, twin ? 'existing_retail' : 'split', twin ? twin.id : null, JSON.stringify(cur)],
      });
      await tx.commit();
      if (twin) existing++; else split++;
    } catch (e) {
      try { await tx.rollback(); } catch (_) {}
      console.error(`[products] couldn't separate rental item ${cur.id} (${cur.sku}) from its retail item: ${e.message}`);
    }
  }
  if (split || existing) console.log(`[products] separated retail items from rental items sharing their SKU: ${split} retail items created, ${existing} already existed under another spelling`);
}

module.exports = { relaxProductSkuUnique, splitRetailFromRentalImports };
