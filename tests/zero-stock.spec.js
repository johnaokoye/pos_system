import { test, expect } from './fixtures.js';

// Reports > Inventory > Zero & Negative Stock (GET /reports/zero-negative-stock).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('lists inventory items at or below zero per location, with status and location filters', async ({ page }) => {
  const stamp = Date.now();
  const branch = (await api(page, 'GET', '/branches')).find(b => b.active);
  const make = async (suffix, adjust) => {
    const p = await api(page, 'POST', '/products', { sku: `ZNS-${stamp}-${suffix}`, name: `Zero Report ${suffix} ${stamp}`, price: 10, cost: 4 });
    await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: adjust, branch_id: branch.id, reason: 'test' });
    return p;
  };
  const neg = await make('NEG', -3);
  const zero = await make('ZERO', 0);
  const pos = await make('POS', 5);
  // A rental item at 0 is never listed.
  await api(page, 'POST', '/products', { sku: `ZNS-${stamp}-RENT`, name: `Zero Report RENT ${stamp}`, is_rental: 1, rental_rate: 5 });

  const run = q => api(page, 'GET', `/reports/zero-negative-stock?q=${encodeURIComponent(`ZNS-${stamp}`)}${q}`);
  const all = await run('');
  expect(all.items.map(r => r.product_id).sort()).toEqual([neg.id, zero.id].sort());
  const negRow = all.items.find(r => r.product_id === neg.id);
  expect(negRow).toMatchObject({ branch_id: branch.id, branch_name: branch.name, on_hand: -3, cost: 4, value: -12 });
  expect(all.summary).toMatchObject({ items: 2, negative: 1, zero: 1, negative_units: -3, negative_value: -12 });
  expect(all.items.some(r => r.product_id === pos.id)).toBe(false);

  expect((await run('&status=negative')).items.map(r => r.product_id)).toEqual([neg.id]);
  expect((await run('&status=zero')).items.map(r => r.product_id)).toEqual([zero.id]);
  const other = (await api(page, 'GET', '/branches')).find(b => b.active && b.id !== branch.id);
  if (other) expect((await run(`&branch_id=${other.id}`)).items).toEqual([]);

  // The tile opens it from Inventory Reports.
  await page.evaluate(() => App.showSection('reports-inventory'));
  await page.locator('.card', { hasText: 'Zero & Negative Stock' }).getByRole('button', { name: 'View Report' }).click();
  await page.fill('#zns-q', `ZNS-${stamp}`);
  await page.locator('.modal').getByRole('button', { name: 'Generate' }).click();
  await expect(page.locator('#rpt-modal-content tbody tr')).toHaveCount(2);
  await expect(page.locator('#rpt-modal-content tbody tr').first()).toContainText(`Zero Report NEG ${stamp}`);
});
