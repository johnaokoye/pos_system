import { test, expect } from './fixtures.js';

// A purchase request line typed in by name (not an inventory item) can still
// be asked for in a unit from the managed list — or a new one added there —
// and the unit carries onto the PO.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('a typed-in PR line takes a unit, new or existing, through to the PO', async ({ page }) => {
  const s = `${Date.now()}`;
  const box = await api(page, 'POST', '/units', { name: `Box${s}`, abbreviation: 'bx' });

  await page.evaluate(() => App.showPRForm());
  await page.fill('#pri-name-0', `Pens ${s}`);
  const unit0 = page.locator('#pri-unit-0');
  await expect(unit0).toBeEnabled();
  await unit0.selectOption(String(box.id));
  await page.fill('#pri-qty-0', '3');
  await page.fill('#pri-cost-0', '500');

  // A second line with a brand-new unit.
  await page.evaluate(() => App.addPRItem());
  await page.fill('#pri-name-1', `Paint ${s}`);
  await page.locator('#pri-unit-1').selectOption('__new');
  await page.fill('#plu-name', `Gal${s}`);
  await page.check('#plu-decimal');
  await page.click('#plu-save');
  await expect(page.locator('#pri-unit-1 option:checked')).toHaveText(`Gal${s}`);
  await page.fill('#pri-qty-1', '2.5');
  await page.fill('#pri-cost-1', '4000');
  await page.getByRole('button', { name: 'Save Draft' }).click();

  let pr;
  await expect.poll(async () => { pr = (await api(page, 'GET', `/purchase-requests?q=${encodeURIComponent('Pens ' + s)}`))[0]; return !!pr; }).toBe(true);
  const full = await api(page, 'GET', `/purchase-requests/${pr.id}`);
  const pens = full.items.find(i => i.product_name === `Pens ${s}`);
  const paint = full.items.find(i => i.product_name === `Paint ${s}`);
  expect(pens).toMatchObject({ uom_id: box.id, purchase_unit: `Box${s}`, units_per: 1, quantity: 3 });
  expect(paint).toMatchObject({ purchase_unit: `Gal${s}`, units_per: 1, quantity: 2.5 });

  // Approved and converted: the PO line is in the same unit.
  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const sup = await api(page, 'POST', '/suppliers', { name: `Unit Supplier ${s}` });
  await page.evaluate(id => App.showPRForm(id), pr.id);
  await expect(page.locator('#pri-unit-0 option:checked')).toHaveText(`Box${s}`);
  await page.evaluate(() => App.closeModal());
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'submitted' });
  await api(page, 'PATCH', `/purchase-requests/${pr.id}/status`, { status: 'approved', signature: SIG });
  const po = await api(page, 'POST', `/purchase-requests/${pr.id}/convert`, { supplier_id: sup.id });
  const poFull = await api(page, 'GET', `/purchase-orders/${po.id || po.po_id}`);
  expect(poFull.items.find(i => i.product_name === `Pens ${s}`)).toMatchObject({ purchase_unit: `Box${s}`, uom_id: box.id, units_per: 1 });
});
