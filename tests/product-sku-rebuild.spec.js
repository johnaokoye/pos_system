import { test, expect } from '@playwright/test';
const os = require('os');
const path = require('path');
const fs = require('fs');

// lib/productKinds relaxProductSkuUnique rebuilds an old `sku TEXT UNIQUE`
// products table. Triggers/views that are on products — or only mention it,
// like the SmartCommerce sync triggers on branch_inventory — must survive,
// and mustn't fail the rename ("error in trigger …: no such table:
// main.products"). Runs against its own throwaway database, no server.
const { createClient } = require('@libsql/client');
const { relaxProductSkuUnique } = require('../lib/productKinds');

test('the SKU-per-kind rebuild keeps triggers and views that use products', async () => {
  const file = path.join(os.tmpdir(), `sku-rebuild-${process.pid}-${Date.now()}.db`);
  const db = createClient({ url: `file:${file}` });
  try {
    await db.batch([
      'CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE NOT NULL, name TEXT, price REAL DEFAULT 0, is_rental INTEGER DEFAULT 0)',
      'CREATE TABLE branch_inventory (product_id INTEGER, branch_id INTEGER, stock_qty INTEGER)',
      'CREATE TABLE events (what TEXT)',
      'CREATE INDEX idx_products_name ON products(name)',
      // On another table, only mentioning products — what broke the rename.
      `CREATE TRIGGER stock_event AFTER INSERT ON branch_inventory BEGIN
         INSERT INTO events SELECT 'stock:' || p.sku FROM products p WHERE p.id = NEW.product_id; END`,
      // On products itself — dropped along with the old table.
      `CREATE TRIGGER price_event AFTER UPDATE OF price ON products BEGIN
         INSERT INTO events VALUES ('price:' || NEW.sku); END`,
      'CREATE VIEW priced AS SELECT sku, price FROM products WHERE price > 0',
      "INSERT INTO products (sku, name, price) VALUES ('A1', 'Ladder', 10), ('B2', 'Drill', 0)",
      'DELETE FROM products WHERE sku = \'B2\'',
    ], 'write');
    const schema = async () => (await db.execute("SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view', 'index') AND sql IS NOT NULL ORDER BY type, name")).rows.map(r => `${r.type} ${r.name}: ${r.sql}`);
    const before = await schema();

    await relaxProductSkuUnique(db);

    const after = await schema();
    for (const s of before) expect(after).toContain(s);
    expect((await db.execute("SELECT sql FROM sqlite_master WHERE name = 'products'")).rows[0].sql).not.toMatch(/sku\s+TEXT\s+UNIQUE/i);

    // Both triggers and the view still work on the rebuilt table.
    await db.execute("UPDATE products SET price = 12 WHERE sku = 'A1'");
    await db.execute("INSERT INTO branch_inventory VALUES ((SELECT id FROM products WHERE sku = 'A1'), 1, 5)");
    expect((await db.execute('SELECT what FROM events ORDER BY rowid')).rows.map(r => r.what)).toEqual(['price:A1', 'stock:A1']);
    expect((await db.execute('SELECT price FROM priced')).rows[0].price).toBe(12);

    // A retail and a rental item can share a SKU; ids aren't reused.
    await db.execute("INSERT INTO products (sku, name, is_rental) VALUES ('A1', 'Ladder hire', 1)");
    const { rows: [n] } = await db.execute("SELECT MAX(id) AS m FROM products");
    expect(n.m).toBe(3);
    await expect(db.execute("INSERT INTO products (sku, name, is_rental) VALUES ('A1', 'dup', 1)")).rejects.toThrow(/UNIQUE/);
  } finally {
    db.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }
});
