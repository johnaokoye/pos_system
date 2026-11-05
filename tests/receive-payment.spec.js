import { test, expect } from './fixtures.js';

const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
let n = 0;

// A credit customer with one taxed sale on account.
async function customerWithInvoice(page, flagged) {
  const stamp = `${Date.now()}${++n}`;
  const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0 && p.tax_rate > 0)));
  const c = await api(page, 'POST', '/customers', { first_name: 'Exempt', last_name: `T${stamp}`, phone: stamp.slice(-10), customer_type: 'credit', credit_limit: 100000, credit_terms_days: 30, force: true });
  const sale = await api(page, 'POST', '/transactions', { customer_id: c.id, items: [{ product_id: product.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'credit', amount_tendered: 0 });
  if (flagged) {
    const full = await api(page, 'GET', `/customers/${c.id}`);
    await api(page, 'PUT', `/customers/${c.id}`, { ...full, tax_exempt: 1, tax_exemption_number: 'JDF-1' });
  }
  return { c, sale };
}

async function openReceivePayment(page, customerId) {
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts);
  await page.evaluate(() => { App.currentDrawerSession = App.currentDrawerSession || { id: null, branch_id: 1 }; return App.showReceivePaymentModal(); });
  await page.evaluate(id => App._rpLoad(id), customerId);
  await expect(page.locator('#rp-method')).toBeVisible();
}

test.describe('POS Receive Payment: Tax Exempt tender', () => {
  test('is always listed, and can\'t be chosen until the customer is marked', async ({ page }) => {
    const { c } = await customerWithInvoice(page, false);
    await openReceivePayment(page, c.id);
    const option = page.locator('#rp-method option[value="tax_exempt"]');
    await expect(option).toHaveCount(1);
    await expect(option).toBeDisabled();
    await expect(option).toHaveText('Tax Exempt (customer not marked)');
    await expect(page.locator('#rp-exempt-note')).toContainText("Tax Exempt on this customer's form");

    // The server keeps the rule too.
    const refused = await page.evaluate(id => App.api('POST', '/customer-payments', { customer_id: id, amount: 1, payment_method: 'tax_exempt', payment_mode: 'invoices', allocations: [] }).then(() => 'accepted', e => e.message), c.id);
    expect(refused).not.toBe('accepted');
  });

  test('a marked customer clears the GCT on an invoice', async ({ page }) => {
    const { c, sale } = await customerWithInvoice(page, true);
    await openReceivePayment(page, c.id);
    await expect(page.locator('#rp-exempt-note')).toHaveCount(0);
    await page.selectOption('#rp-method', 'tax_exempt');
    await expect(page.locator('th', { hasText: 'GCT to Clear' })).toBeVisible();
    await page.locator('.rp-pick').first().check();
    await expect(page.locator('#rp-amount')).toHaveValue(Number(sale.tax_amount).toFixed(2));
    await page.click('#rp-submit');
    await expect(page.locator('#rp-submit')).toHaveCount(0);

    const after = await api(page, 'GET', `/customer-payments/${c.id}`);
    expect(after.invoices[0].balance_due).toBeCloseTo(sale.total - sale.tax_amount, 2);
    expect(after.invoices[0].gct_room).toBe(0);
  });
});
