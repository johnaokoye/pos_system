import { test, expect } from './fixtures.js';

const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
let n = 0;
const stamp = () => `${Date.now()}${++n}`;

const customer = (page, last, extra = {}) => api(page, 'POST', '/customers', { first_name: 'Fence', last_name: last, customer_type: 'credit', credit_limit: 1000, credit_terms_days: 30, force: true, ...extra });
const legacyInvoice = (page, customerId, amount) => api(page, 'POST', '/accounts/legacy-invoices', { customer_id: customerId, invoice_number: `OLD-${stamp()}`, invoice_date: '2026-10-21', amount });

test.describe('Merge Customer In', () => {
  test('merges two records that share no phone or email, into the one chosen', async ({ page }) => {
    const s = stamp();
    // Like CUST-36461: the legacy invoices and credit limit, but no contact details.
    const keep = await customer(page, `Associates ${s}`, { credit_limit: 300000 });
    const dup = await customer(page, `Assoicates ${s}`, { phone: s.slice(-10), email: `fence${s}@example.com` });
    const keptInvoice = await legacyInvoice(page, keep.id, 500);
    const movedInvoice = await legacyInvoice(page, dup.id, 200);

    await page.evaluate(id => App.viewCustomer(id), keep.id);
    await page.click('button:has-text("Merge Customer In")');
    await expect(page.locator('#mci-keep')).toContainText(keep.customer_number);
    await expect(page.locator('#mci-confirm')).toBeDisabled();

    // Choosing the kept record itself is refused.
    await page.fill('#mci-source-search', keep.customer_number);
    await page.locator('#mci-source-dd .nav-item', { hasText: keep.customer_number }).click();
    await expect(page.locator('#mci-details')).toContainText("the customer you're keeping");
    await expect(page.locator('#mci-confirm')).toBeDisabled();

    await page.fill('#mci-source-search', dup.customer_number);
    await page.locator('#mci-source-dd .nav-item', { hasText: dup.customer_number }).click();
    await expect(page.locator('#mci-details')).toContainText('1 legacy invoice');
    await expect(page.locator('#mci-books-warning')).toContainText(dup.customer_number);
    await page.click('#mci-confirm');
    await expect(page.locator('#mci-source-search')).toHaveCount(0);
    await expect(page.locator('.modal-title', { hasText: 'Associates' })).toBeVisible();

    const kept = await api(page, 'GET', `/customers/${keep.id}`);
    expect(kept.customer_number).toBe(keep.customer_number);
    expect(kept.account_balance).toBeCloseTo(700, 2);
    expect(kept.credit_limit).toBe(300000);
    expect(kept.phone).toBe(dup.phone);
    expect(kept.email).toBe(dup.email);
    expect(kept.notes).toContain(dup.customer_number);

    const retired = await api(page, 'GET', `/customers/${dup.id}`);
    expect(retired.active).toBeFalsy();
    expect(retired.merged_into_customer_id).toBe(keep.id);
    expect(retired.account_balance).toBe(0);

    // What Books reads for this account: both invoices are on the kept record, none on the retired one.
    const account = await api(page, 'GET', `/accounts/customer/${keep.id}/receivables`);
    expect(account.invoices.map(i => i.number).sort()).toEqual([keptInvoice.invoice_number, movedInvoice.invoice_number].sort());
    expect((await api(page, 'GET', `/accounts/customer/${dup.id}/receivables`)).invoices).toHaveLength(0);
  });

  test('only people who can merge get the button', async ({ page }) => {
    const c = await customer(page, `NoMerge ${stamp()}`);
    await page.evaluate(() => { App._realCan = App.can; App.can = key => key !== 'customers_merge' && App._realCan(key); });
    await page.evaluate(id => App.viewCustomer(id), c.id);
    await expect(page.locator('.modal-title', { hasText: 'NoMerge' })).toBeVisible();
    await expect(page.locator('button:has-text("Merge Customer In")')).toHaveCount(0);
    await page.evaluate(() => { App.can = App._realCan; delete App._realCan; });
  });
});
