import { test, expect } from './fixtures.js';

const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
let n = 0;

// A credit customer, not marked Tax Exempt and with no exemption number, with one taxed sale on account.
async function customerWithInvoice(page) {
  const stamp = `${Date.now()}${++n}`;
  const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0 && p.tax_rate > 0)));
  const c = await api(page, 'POST', '/customers', { first_name: 'Exempt', last_name: `T${stamp}`, phone: stamp.slice(-10), customer_type: 'credit', credit_limit: 100000, credit_terms_days: 30, force: true });
  const sale = await api(page, 'POST', '/transactions', { customer_id: c.id, items: [{ product_id: product.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'credit', amount_tendered: 0 });
  return { c, sale };
}

// Signs out and back in as a new member of the seeded Cashier group.
async function signInAsCashier(page) {
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Cashier');
  const username = `cashier${Date.now()}${++n}`;
  await api(page, 'POST', '/employees', { first_name: 'Test', last_name: 'Cashier', username, pin: username.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

async function openReceivePayment(page, customerId) {
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts);
  await page.evaluate(() => { App.currentDrawerSession = App.currentDrawerSession || { id: null, branch_id: 1 }; return App.showReceivePaymentModal(); });
  await page.evaluate(id => App._rpLoad(id), customerId);
  await expect(page.locator('#rp-method')).toBeVisible();
}

test.describe('POS Receive Payment: Tax Exempt tender', () => {
  test('a cashier clears the GCT for a customer who isn\'t marked and has no exemption number', async ({ page }) => {
    const { c, sale } = await customerWithInvoice(page);
    expect(sale.tax_amount).toBeGreaterThan(0);
    expect(c.tax_exempt).toBeFalsy();

    await signInAsCashier(page);
    await openReceivePayment(page, c.id);
    await expect(page.locator('#rp-method option[value="tax_exempt"]')).toBeEnabled();
    await page.selectOption('#rp-method', 'tax_exempt');
    await expect(page.locator('th', { hasText: 'GCT to Clear' })).toBeVisible();
    await page.locator('.rp-pick').first().check();
    await expect(page.locator('#rp-amount')).toHaveValue(Number(sale.tax_amount).toFixed(2));
    await page.click('#rp-submit');
    await expect(page.locator('#rp-submit')).toHaveCount(0);

    // Only the GCT comes off, and the invoice itself keeps its tax.
    const after = await api(page, 'GET', `/customer-payments/${c.id}`);
    expect(after.invoices[0].balance_due).toBeCloseTo(sale.total - sale.tax_amount, 2);
    expect(after.invoices[0].gct_room).toBe(0);
    expect(after.invoices[0].total).toBe(sale.total);
    const invoice = await api(page, 'GET', `/transactions/${sale.id}`);
    expect(invoice.tax_amount).toBe(sale.tax_amount);

    // It can't clear more than the GCT on the invoice, or clear it twice.
    const refused = await page.evaluate(([id, txId]) => App.api('POST', '/customer-payments', { customer_id: id, amount: 1, payment_method: 'tax_exempt', payment_mode: 'invoices', allocations: [{ transaction_id: txId, amount: 1 }] }).then(() => 'accepted', e => e.message), [c.id, sale.id]);
    expect(refused).toContain('no GCT left to clear');
  });
});
