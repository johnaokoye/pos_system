import { test, expect } from './fixtures.js';

// New Consignment Agreement: an item that isn't in inventory yet can be
// created from the item picker and lands on the agreement.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const stamp = () => `${Date.now()}`;

test.describe('Consignment agreement — new product', () => {
  test('the item picker creates a product and adds it to the agreement with its agreed cost', async ({ page }) => {
    const supplier = await api(page, 'POST', '/suppliers', { name: `Cons NP Supplier ${stamp()}` });
    await page.evaluate(() => App.showConsAgreementForm());
    await page.locator('#ca-supplier').evaluate((sel, id) => { sel.value = id; sel.dispatchEvent(new Event('change')); }, String(supplier.id));
    await page.fill('#ca-ownership', 'Stock remains the supplier\'s until sold');

    // Type a name that matches nothing, then "+ Add “…”".
    const name = `Consigned Widget ${stamp()}`;
    const sku = `CNP-${stamp()}`;
    const picker = page.locator('#ca-items .ca-item').first().locator('.ss-wrap input');
    await picker.fill(name);
    await page.locator('.ss-wrap .nav-item', { hasText: `+ Add “${name}”` }).click();

    await expect(page.locator('#cnp-name')).toHaveValue(name);
    await page.fill('#cnp-sku', sku);
    await page.fill('#cnp-price', '45');
    await page.fill('#cnp-cost', '30');
    await page.click('#cnp-save');
    await expect(page.locator('#secondary-modal-overlay')).toHaveCount(0);

    // Selected on the row, with the agreed cost carried over.
    await expect(picker).toHaveValue(`${name} (${sku})`);
    await expect(page.locator('#ca-items .ca-cost').first()).toHaveValue('30');

    // A second row offers it too.
    await page.click('button:has-text("+ Add Item")');
    expect(await page.locator('#ca-items .ca-prod').nth(1).evaluate((sel, s) => [...sel.options].some(o => o.text.includes(s)), sku)).toBe(true);

    await page.click('button:has-text("Save Draft")');
    await expect(page.locator('.alert-success', { hasText: 'saved' }).last()).toBeVisible();

    const product = (await api(page, 'GET', '/products')).find(p => p.sku === sku);
    expect(product).toBeTruthy();
    expect(Number(product.stock_qty)).toBe(0);
    expect(Number(product.supplier_id)).toBe(supplier.id);
    const agreements = await api(page, 'GET', '/consignment/agreements');
    const a = await api(page, 'GET', `/consignment/agreements/${agreements.find(x => x.supplier_id === supplier.id).id}`);
    expect(a.items.map(i => [i.product_id, Number(i.current_cost ?? i.cost)])).toEqual([[product.id, 30]]);
  });

  test('cancelling the new product form leaves the row empty', async ({ page }) => {
    await page.evaluate(() => App.showConsAgreementForm());
    const picker = page.locator('#ca-items .ca-item').first().locator('.ss-wrap input');
    await picker.fill(`Never Made ${stamp()}`);
    await picker.press('Enter');
    await page.click('#cnp-cancel');
    await expect(page.locator('#secondary-modal-overlay')).toHaveCount(0);
    await expect(picker).toHaveValue('');
    expect(await page.locator('#ca-items .ca-prod').first().inputValue()).toBe('');
  });
});
