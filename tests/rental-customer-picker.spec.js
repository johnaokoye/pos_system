import { test, expect } from './fixtures.js';

// New Rental only lists customers who can rent today: rental approved (every
// document on file) or preapproved.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('the New Rental customer list shows only rental-approved or preapproved customers', async ({ page }) => {
  const s = `${Date.now()}`;
  const tag = `Pick${s}`;
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [
    { first_name: 'Pre', last_name: `${tag} Approved`, phone: `871${s.slice(-7)}`, customer_type: 'cash', is_rental_customer: '1', rental_preapproved: '1' },
    { first_name: 'Half', last_name: `${tag} Missing`, phone: `872${s.slice(-7)}`, customer_type: 'cash', is_rental_customer: '1' },
    { first_name: 'Not', last_name: `${tag} Renter`, phone: `873${s.slice(-7)}`, customer_type: 'cash' },
  ] });
  const names = rows => rows.map(c => c.first_name).sort();
  expect(names(await api(page, 'GET', `/customers?active=1&limit=50&type=rental_approved&search=${tag}`))).toEqual(['Pre']);
  expect(names(await api(page, 'GET', `/customers?active=1&limit=50&type=other&search=${tag}`))).toEqual(['Half', 'Not']);
  const paged = await api(page, 'GET', `/customers?paged=1&type=rental_approved&search=${tag}`);
  expect(paged.total).toBe(1);

  await page.evaluate(() => App.showSection('rentals'));
  await page.evaluate(() => App.showRentalCheckoutModal());
  await page.fill('#rc-customer-search', tag);
  const dd = page.locator('#rc-customer-dd');
  await expect(dd).toContainText(`Pre ${tag} Approved`);
  await expect(dd).not.toContainText('Half');
  await expect(dd).not.toContainText('Not ');
  await page.fill('#rc-customer-search', `${tag} Missing`);
  await expect(dd).toContainText('No rental-approved or preapproved customers found');

  // A rental quote's customer box is limited the same way.
  await page.evaluate(() => App.closeModal());
  await page.evaluate(() => App.showQuoteForm(null, 'rental'));
  await page.fill('#qt-cust-search', tag);
  const qdd = page.locator('#qt-cust-dd');
  await expect(qdd).toContainText(`Pre ${tag} Approved`);
  await expect(qdd).not.toContainText('Half');
  await expect(qdd).not.toContainText('Not ');
  await expect(page.locator('#qt-cust-hint')).toBeVisible();
  // A retail quote still lists everyone.
  await page.evaluate(() => App.closeModal());
  await page.evaluate(() => App.showQuoteForm(null, 'retail'));
  await page.fill('#qt-cust-search', tag);
  await expect(page.locator('#qt-cust-dd')).toContainText('Half');
});
