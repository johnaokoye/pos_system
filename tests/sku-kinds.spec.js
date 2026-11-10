import { test, expect } from './fixtures.js';

// A rental item and a retail item may share a SKU (unique per kind,
// lib/productKinds.js): each import only matches items of its own kind, the
// item forms only refuse a SKU already used by the same kind, and the POS
// rings up the retail item.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const refused = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'allowed', e => e.message), [method, url, data]);
const bySku = async (page, sku) => (await api(page, 'GET', `/products?search=${encodeURIComponent(sku)}`)).filter(p => p.sku === sku);

test('retail and rental imports keep items with the same SKU apart', async ({ page }) => {
  const sku = `KIND-${Date.now()}`;
  await api(page, 'POST', '/products/import', { rows: [{ sku, name: 'Retail Ladder', price: '100', cost: '60', stock_qty: '4' }] });
  const rental = await api(page, 'POST', '/products/import/rentals', { rows: [{ sku, name: 'Hire Ladder', daily_rate: '15', stock_qty: '2' }] });
  expect(rental).toMatchObject({ created: 1, updated: 0, errors: [] });

  let items = await bySku(page, sku);
  expect(items).toHaveLength(2);
  const retailItem = items.find(p => !p.is_rental), rentalItem = items.find(p => p.is_rental);
  expect(retailItem).toMatchObject({ name: 'Retail Ladder', price: 100 });
  expect(rentalItem.name).toBe('Hire Ladder');

  // Re-importing each side updates only that side.
  await api(page, 'POST', '/products/import', { rows: [{ sku, name: 'Retail Ladder v2', price: '120', cost: '60', stock_qty: '4' }] });
  await api(page, 'POST', '/products/import/rentals', { rows: [{ sku, name: 'Hire Ladder v2', daily_rate: '18', stock_qty: '2' }] });
  items = await bySku(page, sku);
  expect(items).toHaveLength(2);
  expect(items.find(p => !p.is_rental)).toMatchObject({ id: retailItem.id, name: 'Retail Ladder v2', price: 120 });
  expect(items.find(p => p.is_rental)).toMatchObject({ id: rentalItem.id, name: 'Hire Ladder v2', price: 0 });
});

test('item forms only refuse a SKU already used by the same kind', async ({ page }) => {
  const sku = `FORM-${Date.now()}`;
  await api(page, 'POST', '/products', { sku, name: 'Retail Saw', price: 50 });
  // Another retail item with it (any case) is refused, a rental item isn't.
  expect(await refused(page, 'POST', '/products', { sku: sku.toLowerCase(), name: 'Retail Saw 2', price: 50 })).toContain('already used by "Retail Saw"');
  const rental = await api(page, 'POST', '/products', { sku, name: 'Hire Saw', is_rental: 1, rental_rate: 10 });
  expect(rental.is_rental).toBe(1);
  expect(await refused(page, 'POST', '/products', { sku, name: 'Hire Saw 2', is_rental: 1, rental_rate: 10 })).toContain('already used by "Hire Saw"');
  // Barcodes stay one set across both kinds.
  const bc = `BC-${Date.now()}`;
  await api(page, 'PUT', `/products/${rental.id}`, { ...rental, barcode: bc });
  expect(await refused(page, 'POST', '/products', { sku: `${sku}-B`, barcode: bc, name: 'Retail Saw B', price: 50 })).toContain('already used by "Hire Saw"');
});

test('the POS rings up the retail item when a rental item sold off the fleet shares its SKU', async ({ page }) => {
  const sku = `POS-${Date.now()}`;
  const rentalItem = await api(page, 'POST', '/products', { sku, name: 'Fleet Drill', is_rental: 1, rental_allow_sale: 1, price: 70, rental_rate: 10 });
  const retailItem = await api(page, 'POST', '/products', { sku, name: 'New Drill', price: 90 });
  const picked = await page.evaluate(([s, ids]) => {
    // Rental first in the list, as an unlucky sort order would put it.
    App.allProducts = [{ id: ids[0], sku: s, barcode: null, name: 'Fleet Drill', is_rental: 1 }, { id: ids[1], sku: s, barcode: null, name: 'New Drill', is_rental: 0 }];
    let added = null;
    const orig = App.addToCart;
    App.addToCart = id => { added = id; };
    const input = document.createElement('input');
    input.id = 'pos-item-input';
    input.value = s;
    document.body.appendChild(input);
    try { App.posSubmitItemInput(); } finally { App.addToCart = orig; input.remove(); }
    return added;
  }, [sku, [rentalItem.id, retailItem.id]]);
  expect(picked).toBe(retailItem.id);
});
