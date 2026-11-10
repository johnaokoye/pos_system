import { test, expect } from './fixtures.js';

// Old-system credit notes on cash customers (customers_legacy_credit): the
// Available Credit box on the customer's History view.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test("an old credit note is added from a cash customer's History", async ({ page }) => {
  const stamp = Date.now();
  const c = await api(page, 'POST', '/customers', { first_name: 'Legacy', last_name: `Credit ${stamp}`, phone: `876${String(stamp).slice(-7)}`, customer_type: 'cash' });
  await page.evaluate(id => App.viewCustomer(id), c.id);
  const box = page.locator('#cust-credits');
  await expect(box).toContainText('Available Credit');

  page.on('dialog', d => d.accept());
  await box.getByRole('button', { name: '+ Add Old Credit Note' }).click();
  await page.fill('#lcn-number', `OLD-${stamp}`);
  await page.fill('#lcn-date', '2026-01-15');
  await page.fill('#lcn-amount', '250');
  await page.click('#lcn-save');
  await expect(box).toContainText('$250.00');
  expect((await api(page, 'GET', `/customers/${c.id}/credits`)).available).toBe(250);

  // Not offered on a credit account's History, nor on the Edit form.
  const credit = await api(page, 'POST', '/customers', { first_name: 'Legacy', last_name: `Account ${stamp}`, phone: `875${String(stamp).slice(-7)}`, customer_type: 'credit', credit_terms_days: 30, credit_limit: 1000 });
  await page.evaluate(() => App.closeModal());
  await page.evaluate(id => App.viewCustomer(id), credit.id);
  await expect(page.locator('#ch-table')).toBeVisible();
  await expect(page.locator('#cust-credits')).toHaveCount(0);
  await page.evaluate(() => App.closeModal());
  await page.evaluate(id => App.showCustomerForm(id), c.id);
  await expect(page.locator('#cf-type')).toBeVisible();
  await expect(page.locator('#cust-credits')).toHaveCount(0);
});
