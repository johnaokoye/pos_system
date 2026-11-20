import { test, expect } from './fixtures.js';

// A product's Bin Locations tab: type Zone / Bay, Shelf and Bin Number — a
// new bay/bin is created there and shows in Warehouse Management, which
// filters by bay and shelf and lists each bin's items.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);

test('bins are created and assigned from the product screen, and filter by bay and shelf', async ({ page }) => {
  const s = `${Date.now()}`.slice(-7);
  const [branch, other] = (await api(page, 'GET', '/branches')).filter(b => b.active);
  const products = (await api(page, 'GET', '/products')).filter(p => !p.is_rental && !p.has_variations && p.product_type !== 'service');
  const [p1, p2] = products;
  const bay = `Bay ${s}`, binCode = `TT${s}`;

  // From the product's Bin Locations tab.
  await page.evaluate(([id, b]) => { App._binPanelBranchId = b; return App.showProductForm(id); }, [p1.id, branch.id]);
  await page.click('#ptab-bins');
  await page.waitForSelector('#binp-bin');
  await page.fill('#binp-zone', bay);
  await page.fill('#binp-shelf', '3');
  await page.fill('#binp-bin', binCode);
  await page.click('button:has-text("Assign")');
  await expect(page.locator('#bin-panel table')).toContainText(binCode);
  await expect(page.locator('#bin-panel table')).toContainText(bay);
  await page.evaluate(() => App.closeModal());

  // The bay and bin now exist in Warehouse Management.
  const zone = (await api(page, 'GET', `/warehouse/zones?branch_id=${branch.id}`)).find(z => z.name === bay);
  expect(zone).toBeTruthy();
  const bin = (await api(page, 'GET', `/warehouse/bins?zone_id=${zone.id}`)).find(b => b.bin_code === binCode);
  expect(bin).toMatchObject({ shelf: '3', branch_id: branch.id });
  expect(bin.items).toContain(p1.name);

  // The same bin number for a second item reuses it (same bay — not a new one).
  const again = await api(page, 'POST', '/warehouse/bins/locate', { branch_id: branch.id, zone: bay.toUpperCase(), shelf: '3', bin_code: binCode.toLowerCase() });
  expect(again.id).toBe(bin.id);
  expect(again.created).toBe(false);
  expect((await api(page, 'GET', `/warehouse/zones?branch_id=${branch.id}`)).filter(z => z.name.toLowerCase() === bay.toLowerCase())).toHaveLength(1);
  await api(page, 'POST', '/warehouse/assignments', { product_id: p2.id, bin_id: bin.id, branch_id: branch.id, quantity: 0 });
  expect(await attempt(page, 'POST', '/warehouse/assignments', { product_id: p2.id, bin_id: bin.id, branch_id: branch.id, quantity: 0 })).toContain('already in bin');

  // A bin number already used elsewhere is refused.
  expect(await attempt(page, 'POST', '/warehouse/bins/locate', { branch_id: branch.id, zone: bay, shelf: '4', bin_code: binCode })).toContain('already in');
  if (other) expect(await attempt(page, 'POST', '/warehouse/bins/locate', { branch_id: other.id, bin_code: binCode })).toContain(`already at ${branch.name}`);
  // A second bin on another shelf of the same bay.
  const bin2 = await api(page, 'POST', '/warehouse/bins/locate', { branch_id: branch.id, zone: bay, shelf: '5', bin_code: `TU${s}` });
  expect(bin2).toMatchObject({ zone_id: zone.id, shelf: '5', created: true });

  // Warehouse → Bins: filter by bay, then shelf; each bin shows its items.
  await page.evaluate(() => { App.warehouseTab = 'bins'; return App.showSection('warehouse'); });
  await page.waitForSelector('#bin-filter-zone');
  await page.selectOption('#bin-filter-zone', String(zone.id));
  await expect(page.locator('#bins-tbody tr')).toHaveCount(2);
  await expect(page.locator('#bin-filter-shelf option')).toHaveText(['All Shelves', 'Shelf 3', 'Shelf 5']);
  await page.selectOption('#bin-filter-shelf', '3');
  await expect(page.locator('#bins-tbody tr')).toHaveCount(1);
  await expect(page.locator('#bins-tbody')).toContainText(p1.name);
  await expect(page.locator('#bins-tbody')).toContainText(p2.name);

  // Product Assignments: the same filters.
  const rows = await api(page, 'GET', `/warehouse/assignments?zone_id=${zone.id}&shelf=3`);
  expect(rows.map(r => r.product_id).sort()).toEqual([p1.id, p2.id].sort());
  expect(rows[0].shelf).toBe('3');
});
