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

  test('a deactivated customer with a balance can be found, reactivated and then merged into', async ({ page }) => {
    page.on('dialog', d => d.accept());
    const s = stamp();
    const keep = await customer(page, `Hidden ${s}`, { credit_limit: 300000 });
    const dup = await customer(page, `Hiddne ${s}`, { phone: s.slice(-10) });
    // Hidden with a balance, as existing records can be: deactivated with nothing owing, then a credit sale.
    await api(page, 'DELETE', `/customers/${keep.id}`);
    const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0)));
    const sale = await api(page, 'POST', '/transactions', { customer_id: keep.id, items: [{ product_id: product.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'credit', amount_tendered: 0 });

    // Hidden from search, but what Books reads still answers.
    expect((await api(page, 'GET', `/accounts/customer/${keep.id}/receivables`)).customer.account_balance).toBeCloseTo(sale.total, 2);
    await page.evaluate(() => App.showSection('customers'));
    await page.fill('#cust-search', keep.customer_number);
    await expect(page.locator('#cust-table')).not.toContainText(keep.customer_number);

    await page.selectOption('#cust-status-filter', 'inactive');
    const row = page.locator('#cust-table tr', { hasText: keep.customer_number });
    await expect(row).toContainText('Inactive');
    await expect(row).toContainText('Owes');
    await expect(row.locator('button:has-text("Edit")')).toHaveCount(0);
    await row.locator('button:has-text("Reactivate")').click();
    await expect(page.locator('#cust-table')).not.toContainText(keep.customer_number);

    await page.selectOption('#cust-status-filter', '');
    await expect(row).toBeVisible();
    const back = await api(page, 'GET', `/customers/${keep.id}`);
    expect(back.active).toBeTruthy();
    expect(back.account_balance).toBeCloseTo(sale.total, 2);
    expect(back.customer_number).toBe(keep.customer_number);
    expect(await api(page, 'POST', '/customers/merge', { keep_id: keep.id, merge_ids: [dup.id] })).toMatchObject({ merged: 1 });
  });

  test('reactivating is refused for a merged customer and on a phone clash', async ({ page }) => {
    const refused = (id) => page.evaluate(i => App.api('POST', `/customers/${i}/reactivate`).then(() => 'accepted', e => e.message), id);
    const s = stamp();
    const keep = await customer(page, `Survivor ${s}`);
    const merged = await customer(page, `Retired ${s}`);
    await api(page, 'POST', '/customers/merge', { keep_id: keep.id, merge_ids: [merged.id] });
    expect(await refused(merged.id)).toContain('merged');

    const phone = stamp().slice(-10);
    const gone = await customer(page, `Gone ${s}`, { phone });
    await api(page, 'DELETE', `/customers/${gone.id}`);
    const taker = await customer(page, `Taker ${s}`, { phone });
    expect(await refused(gone.id)).toContain(taker.customer_number);
    expect((await api(page, 'GET', `/customers/${gone.id}`)).active).toBeFalsy();
  });

  test('a customer who owes money can\'t be deactivated, from the form or the API', async ({ page }) => {
    page.on('dialog', d => d.accept());
    const c = await customer(page, `Owing ${stamp()}`);
    await legacyInvoice(page, c.id, 1234.5);
    const refused = (method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);

    await page.evaluate(id => App.showCustomerForm(id), c.id);
    await page.click('.modal-footer button:has-text("Delete")');
    await expect(page.locator('body')).toContainText('owes $1,234.50');
    expect((await api(page, 'GET', `/customers/${c.id}`)).active).toBeTruthy();

    expect(await refused('DELETE', `/customers/${c.id}`)).toContain('owes $1,234.50');
    const full = await api(page, 'GET', `/customers/${c.id}`);
    expect(await refused('PUT', `/customers/${c.id}`, { ...full, active: 0 })).toContain('owes $1,234.50');
    expect((await api(page, 'GET', `/customers/${c.id}`)).active).toBeTruthy();
    // Saving them normally still works.
    await api(page, 'PUT', `/customers/${c.id}`, { ...full, city: 'Ocho Rios' });
    expect((await api(page, 'GET', `/customers/${c.id}`)).city).toBe('Ocho Rios');
  });

  test('a legacy invoice from Books is refused for an inactive or merged customer, then goes through once reactivated', async ({ page }) => {
    const refused = id => page.evaluate(i => App.api('POST', '/accounts/legacy-invoices', { customer_id: i, invoice_number: `OLD-${Date.now()}`, invoice_date: '2026-10-21', amount: 100, external_id: 'books-invoice-retry' }).then(() => 'accepted', e => e.message), id);
    const s = stamp();
    const gone = await customer(page, `Inactive ${s}`);
    await api(page, 'DELETE', `/customers/${gone.id}`);
    expect(await refused(gone.id)).toContain('inactive');
    expect((await api(page, 'GET', `/customers/${gone.id}`)).account_balance).toBe(0);

    await api(page, 'POST', `/customers/${gone.id}/reactivate`);
    expect(await refused(gone.id)).toBe('accepted');
    expect((await api(page, 'GET', `/customers/${gone.id}`)).account_balance).toBeCloseTo(100, 2);

    const keep = await customer(page, `MergeKeep ${s}`);
    const merged = await customer(page, `MergeGone ${s}`);
    await api(page, 'POST', '/customers/merge', { keep_id: keep.id, merge_ids: [merged.id] });
    expect(await page.evaluate(i => App.api('POST', '/accounts/legacy-invoices', { customer_id: i, invoice_number: 'OLD-MERGED', invoice_date: '2026-10-21', amount: 100 }).then(() => 'accepted', e => e.message), merged.id)).toContain(keep.customer_number);
  });

  test('a customer with no balance can still be deactivated', async ({ page }) => {
    const c = await customer(page, `Clear ${stamp()}`);
    await api(page, 'DELETE', `/customers/${c.id}`);
    expect((await api(page, 'GET', `/customers/${c.id}`)).active).toBeFalsy();
  });

  test('reversing an import keeps customers who owe money and lists them', async ({ page }) => {
    page.on('dialog', d => d.accept());
    const s = stamp();
    const { id: batchId } = await api(page, 'POST', '/customer-imports', {});
    const row = (last, phone) => ({ first_name: 'Import', last_name: last, phone, customer_type: 'credit', credit_terms_days: 30, credit_limit: 1000 });
    await api(page, 'POST', '/customers/import', { batch_id: batchId, duplicate_mode: 'force', rows: [row(`Owes ${s}`, s.slice(-10)), row(`Clear ${s}`, stamp().slice(-10))] });
    const [owing] = await api(page, 'GET', `/customers?search=${encodeURIComponent(`Owes ${s}`)}&limit=5`);
    const [clear] = await api(page, 'GET', `/customers?search=${encodeURIComponent(`Clear ${s}`)}&limit=5`);
    await legacyInvoice(page, owing.id, 300);

    await page.evaluate(id => App.showCustomerImportBatchDetail(id), batchId);
    await page.click('button:has-text("Reverse This Import")');
    await expect(page.locator('#cib-kept-owing')).toContainText(owing.customer_number);
    await expect(page.locator('#cib-kept-owing')).toContainText('owes');

    expect((await api(page, 'GET', `/customers/${owing.id}`)).active).toBeTruthy();
    expect((await api(page, 'GET', `/customers/${clear.id}`)).active).toBeFalsy();
    const { kept_owing } = await api(page, 'GET', `/customer-imports/${batchId}`);
    expect(kept_owing.map(k => k.id)).toEqual([owing.id]);
  });
});
