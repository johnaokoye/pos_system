import { test, expect } from './fixtures.js';

// The Special Project rental item search shows each item's availability
// before it's picked — on hand, held, available — and when the held or
// rented units come back (GET /quotations/rental-availability).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('rental item search shows availability and when held units are due back', async ({ page }) => {
  const stamp = Date.now();
  const item = await api(page, 'POST', '/products', {
    sku: `SPAV-${stamp}`, name: `Avail Mixer ${stamp}`, is_rental: 1, rental_rate: 50, rental_weekly_rate: 250,
    model_number: 'MX-9', branch_id: 1, stock_qty: 2,
  });
  // Preapproval is only for imported customers, so import one.
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [{
    first_name: 'Avail', last_name: `Renter ${stamp}`, phone: `874${String(stamp).slice(-7)}`, customer_type: 'cash',
    is_rental_customer: '1', rental_preapproved: '1',
  }] });
  const customer = (await api(page, 'GET', `/customers?search=${encodeURIComponent(`Renter ${stamp}`)}`)).find(c => c.last_name === `Renter ${stamp}`);
  expect(customer).toMatchObject({ is_rental_customer: 1, rental_preapproved: 1 });
  // An approved project holds one of the two from Dec 1 to Dec 10.
  const project = await api(page, 'POST', '/quotations', {
    quote_type: 'special_project', employee_id: 1, branch_id: 1, customer_id: customer.id,
    items: [{ product_id: item.id, product_name: item.name, quantity: 1, unit_price: 500, is_rental_line: 1, rental_start: '2026-12-01', rental_end: '2026-12-10' }],
  });
  await api(page, 'PATCH', `/quotations/${project.id}/submit-for-approval`, {});
  expect((await api(page, 'PATCH', `/quotations/${project.id}/approve`, {})).status).toBe('approved');

  const data = await api(page, 'GET', '/quotations/rental-availability?branch_id=1');
  const a = data.items.find(i => i.product_id === item.id);
  expect(a).toMatchObject({ on_hand: 2, out: 0, held: 1, out_of_service: 0, available: 1 });
  expect(a.bookings[0]).toMatchObject({ kind: 'held', qty: 1, quote_number: project.quote_number, from: '2026-12-01', due: '2026-12-10' });

  // On the New Special Project form, before picking the item.
  await page.evaluate(() => App.showQuoteForm(null, 'special_project'));
  const width = await page.locator('.modal').first().evaluate(el => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(720);
  await page.evaluate(() => App.addQuoteRentalItem());
  const search = page.locator('[id^="qti-rprod-search-"]').last();
  await search.fill(`SPAV-${stamp}`);
  const option = page.locator('[id^="qti-rprod-dd-"] .nav-item', { hasText: `Avail Mixer ${stamp}` });
  await expect(option).toContainText('1 available');
  await expect(option).toContainText('Model MX-9');
  await expect(option).toContainText('/wk');
  await expect(option).toContainText('2 on hand · 1 held');
  await expect(option).toContainText(`Held 1 for Special Project ${project.quote_number}`);
  await expect(option).toContainText('Dec 10, 2026');
});
