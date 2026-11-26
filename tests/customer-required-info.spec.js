import { test, expect } from './fixtures.js';

// Owner's rule (2026-11-26): a new customer needs a name, phone number and
// address; an existing customer missing any of them is flagged wherever staff
// pick them, with Update Customer to fill it in.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const apiErr = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => null, e => e.message), [method, url, data]);
const phone = () => `8${String(Math.random()).slice(2, 11)}`;

test('a new customer needs a phone number and address', async ({ page }) => {
  const s = `${Date.now()}`;
  expect(await apiErr(page, 'POST', '/customers', { first_name: 'No', last_name: `Phone ${s}`, address: '1 Road' })).toMatch(/phone number/);
  expect(await apiErr(page, 'POST', '/customers', { first_name: 'No', last_name: `Address ${s}`, phone: phone() })).toMatch(/address/);

  // The form refuses it too, before sending.
  await page.evaluate(() => App.showCustomerForm(null));
  await page.fill('#cf-first', 'Form');
  await page.fill('#cf-last', `Check ${s}`);
  await page.click('.modal-footer .btn-primary');
  await expect(page.locator('body')).toContainText('A new customer needs: phone number, address');
  await page.fill('#cf-phone', phone());
  await page.fill('#cf-addr', '4 Main Street');
  await page.click('.modal-footer .btn-primary');
  await expect(page.locator('.modal')).toHaveCount(0);
  const [made] = await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Check ${s}`)}`);
  expect(made).toMatchObject({ first_name: 'Form', address: '4 Main Street' });
});

test('an existing customer missing details is flagged on the POS and in pickers, and Update Customer fills them in', async ({ page }) => {
  const s = `${Date.now()}`;
  // An older record (imports aren't held to the rule) with no phone or address.
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [{ first_name: 'Old', last_name: `Record ${s}`, email: `old${s}@example.com`, customer_type: 'cash' }] });
  const [old] = await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Record ${s}`)}`);
  expect(old.phone || null).toBeNull();

  // POS: warning badge on the ticket's customer.
  await page.evaluate(() => App.showSection('pos'));
  await page.evaluate(id => App.setCartCustomer(id), old.id);
  const badge = page.locator('#cart-customer-name .badge-warning', { hasText: 'Info missing' });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.locator('#cf-info-missing')).toContainText('phone number, address');
  await page.fill('#cf-phone', phone());
  await page.fill('#cf-addr', '9 Hope Road');
  await page.click('.modal-footer .btn-primary');
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  expect(await page.evaluate(() => App.cartCustomer.address)).toBe('9 Hope Road');

  // A shared picker (quotes, work orders…) shows the notice under the pick.
  await api(page, 'POST', '/customers/import', { batch_id, rows: [{ first_name: 'Older', last_name: `Record ${s}`, email: `older${s}@example.com`, customer_type: 'cash' }] });
  const [older] = await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Older Record ${s}`)}`);
  await page.evaluate(() => App.showModal(`<div class="modal"><div class="modal-body">${App._customerPickerHtml('t-cust', [], null, { remote: '' })}</div></div>`));
  await page.evaluate(id => App._selectCustomerPicker('t-cust', id), older.id);
  await expect(page.locator('#t-cust-info')).toContainText('missing phone number, address');
  await page.locator('#t-cust-info button', { hasText: 'Update Customer' }).click();
  await page.fill('#cf-phone', phone());
  // Saving with something still missing asks first.
  page.once('dialog', d => d.accept());
  await page.click('.modal-footer .btn-primary');
  await expect(page.locator('#t-cust-info')).toContainText('missing address');
  await expect(page.locator('#t-cust')).toHaveValue(String(older.id));
});
