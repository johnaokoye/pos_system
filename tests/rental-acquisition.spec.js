import { test, expect } from './fixtures.js';

// Rental items carry an Acquisition Date, Cost and Last Cost — entered on the
// rental item form, kept by saves that don't send them, and in the CSV
// import/export.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const apiErr = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => null, e => e.message), [method, url, data]);

test('rental item form saves acquisition date, cost and last cost', async ({ page }) => {
  const s = `${Date.now()}`;
  const branch = (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const item = await api(page, 'POST', '/products', { sku: `ACQ-${s}`, name: `Acq Saw ${s}`, is_rental: 1, rental_rate: 40, branch_id: branch.id, stock_qty: 2, acquisition_date: '2025-03-10', cost: 900, last_cost: 950 });
  expect(item).toMatchObject({ acquisition_date: '2025-03-10', cost: 900, last_cost: 950 });

  // Future dates and negative last cost are refused.
  const tomorrow = await page.evaluate(() => App._storeDay(new Date(Date.now() + 2 * 86400000)));
  expect(await apiErr(page, 'POST', '/products', { sku: `ACQ2-${s}`, name: 'x', is_rental: 1, acquisition_date: tomorrow })).toMatch(/future/);
  expect(await apiErr(page, 'PUT', `/products/${item.id}`, { ...item, last_cost: -1 })).toMatch(/Last cost/);

  // Edit through the form.
  await page.evaluate(id => App.showRentalItemForm(id), item.id);
  await expect(page.locator('#rf-acq-date')).toHaveValue('2025-03-10');
  await expect(page.locator('#rf-cost')).toHaveValue('900');
  await expect(page.locator('#rf-last-cost')).toHaveValue('950');
  await page.fill('#rf-acq-date', '2025-04-01');
  await page.fill('#rf-cost', '1000');
  await page.fill('#rf-last-cost', '1100');
  await page.click('.modal-footer .btn-primary');
  await expect(page.locator('.modal')).toHaveCount(0);
  let saved = await api(page, 'GET', `/products/${item.id}`);
  expect(saved).toMatchObject({ acquisition_date: '2025-04-01', cost: 1000, last_cost: 1100 });

  // A PUT without the fields (an older caller) leaves date and last cost alone.
  const { acquisition_date, last_cost, ...rest } = saved;
  await api(page, 'PUT', `/products/${item.id}`, rest);
  saved = await api(page, 'GET', `/products/${item.id}`);
  expect(saved).toMatchObject({ acquisition_date: '2025-04-01', last_cost: 1100 });

  // Import: M/D/YYYY dates, only mapped columns written.
  const res = await api(page, 'POST', '/products/import/rentals', { rows: [{ sku: `ACQ-${s}`, name: `Acq Saw ${s}`, branch_name: branch.name, stock_qty: '2', acquisition_date: '6/5/2024', cost: '1200', last_cost: '1300' }] });
  expect(res.errors).toEqual([]);
  saved = await api(page, 'GET', `/products/${item.id}`);
  expect(saved).toMatchObject({ acquisition_date: '2024-06-05', cost: 1200, last_cost: 1300 });
  await api(page, 'POST', '/products/import/rentals', { rows: [{ sku: `ACQ-${s}`, name: `Acq Saw ${s}`, branch_name: branch.name, stock_qty: '2' }] });
  saved = await api(page, 'GET', `/products/${item.id}`);
  expect(saved).toMatchObject({ acquisition_date: '2024-06-05', cost: 1200, last_cost: 1300 });

  // Export carries the columns.
  const csv = await (await page.request.get('/api/products/export/rentals')).text();
  expect(csv.split('\r\n')[0]).toContain('acquisition_date,cost,last_cost');
  expect(csv).toContain(`ACQ-${s}`);
  expect(csv.split('\r\n').find(l => l.startsWith(`ACQ-${s},`))).toContain('2024-06-05,1200,1300');
});
