import { test, expect } from './fixtures.js';

// GET /rentals/online-availability — what the e-commerce site shows: free per
// branch for the customer's dates (bookings counted on their own days, not
// all from today), free now, and when that many are next free.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('the website sees rental availability for its dates, with an API key limited to rentals:read', async ({ page }) => {
  const s = `${Date.now()}`;
  const branch = (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const day = n => page.evaluate(k => App._storeDay(new Date(Date.now() + k * 86400000)), n);
  const [today, d1, d3, d5, d6, d19, d20, d21, d22, d25, d26] = await Promise.all([0, 1, 3, 5, 6, 19, 20, 21, 22, 25, 26].map(day));

  const item = await api(page, 'POST', '/products', { sku: `ONL-${s}`, name: `Online Lift ${s}`, is_rental: 1, rental_rate: 80, branch_id: branch.id, stock_qty: 3, online_available: 1 });
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [{ first_name: 'Web', last_name: `Renter ${s}`, phone: `875${s.slice(-7)}`, customer_type: 'cash', is_rental_customer: '1', rental_preapproved: '1' }] });
  const customer = (await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Renter ${s}`)}`))[0];

  // Two held at the counter, due back in 5 days.
  await api(page, 'POST', '/rentals/agreements', { customer_id: customer.id, branch_id: branch.id, due_date: d5, items: [{ product_id: item.id, quantity: 2 }] });
  // One held by a Special Project from day 20 to day 25.
  const project = await api(page, 'POST', '/quotations', {
    quote_type: 'special_project', employee_id: 1, branch_id: branch.id, customer_id: customer.id,
    items: [{ product_id: item.id, product_name: item.name, quantity: 1, unit_price: 500, is_rental_line: 1, rental_start: d20, rental_end: d25 }],
  });
  await api(page, 'PATCH', `/quotations/${project.id}/submit-for-approval`, {});
  expect((await api(page, 'PATCH', `/quotations/${project.id}/approve`, {})).status).toBe('approved');

  const key = (await api(page, 'POST', '/api-keys', { name: `Website ${s}`, scopes: ['rentals:read'] })).key;
  const get = async qs => {
    const r = await page.request.get(`/api/rentals/online-availability?${qs}`, { headers: { 'X-API-Key': key } });
    return { status: r.status(), body: await r.json() };
  };
  const at = body => body.items[0].locations.find(l => l.branch_id === branch.id);

  // Today: 3 − 2 at the counter (the project hasn't started).
  let { status, body } = await get(`product_id=${item.id}`);
  expect(status).toBe(200);
  expect(body.items[0]).toMatchObject({ sku: `ONL-${s}`, stock_qty: 3, available_now: 1, available: 1 });
  expect(at(body)).toMatchObject({ stock_qty: 3, available_now: 1, available: 1, next_available: today });

  // Days 20–22: only the project's one is booked.
  ({ body } = await get(`product_id=${item.id}&start=${d20}&end=${d22}`));
  expect(at(body)).toMatchObject({ available_now: 1, available: 2 });
  // Days 3–21 cross both bookings, but never on the same day: the peak is 2.
  ({ body } = await get(`product_id=${item.id}&start=${d3}&end=${d21}`));
  expect(at(body).available).toBe(1);

  // All 3 for 2 days: not today, but from the day after the counter hold ends.
  ({ body } = await get(`product_id=${item.id}&start=${today}&end=${d1}&quantity=3`));
  expect(at(body)).toMatchObject({ available: 1, next_available: d6 });
  expect(body.items[0].next_available).toBe(d6);
  // …and around the project, the day after it ends.
  ({ body } = await get(`product_id=${item.id}&start=${d19}&end=${d21}&quantity=3`));
  expect(at(body)).toMatchObject({ available: 2, next_available: d26 });

  // Every website rental item when no ids are given; several by id.
  ({ body } = await get(''));
  expect(body.items.some(i => i.product_id === item.id)).toBe(true);
  ({ body } = await get(`ids=${item.id},999999999`));
  expect(body.items.map(i => i.product_id)).toEqual([item.id]);

  // Bad ranges are refused.
  expect((await get(`product_id=${item.id}&start=2020-01-01`)).status).toBe(400);
  expect((await get(`product_id=${item.id}&start=${d5}&end=${d3}`)).body.error).toMatch(/on or after start/);

  // rentals:read opens only this: not the agreements, and a products key can't read it.
  expect((await page.request.get('/api/rentals/agreements', { headers: { 'X-API-Key': key } })).status()).toBe(403);
  const productsKey = (await api(page, 'POST', '/api-keys', { name: `Shop ${s}`, scopes: ['products:read'] })).key;
  expect((await page.request.get(`/api/rentals/online-availability?product_id=${item.id}`, { headers: { 'X-API-Key': productsKey } })).status()).toBe(403);
});
