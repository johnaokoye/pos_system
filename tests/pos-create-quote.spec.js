import { test, expect } from './fixtures.js';

// POS "Create Quote": once the quote is created, the ticket is cleared for
// the next customer (and a recalled hold it came from is dropped).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
let n = 0;
const stamp = () => `${Date.now()}${++n}`;

const product = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 20 && p.price > 0 && p.product_type !== 'service')));

async function openPos(page) {
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts);
  await page.evaluate(() => document.getElementById('pos-drawer-overlay')?.remove());
}

const stillHeld = async (page, id) => (await api(page, 'GET', '/transactions?status=hold&limit=500')).find(h => h.id === id);

test.describe('POS Create Quote', () => {
  test('creating the quote clears the ticket and drops the recalled hold', async ({ page }) => {
    const p = await product(page);
    const note = `Quote hold ${stamp()}`;
    const hold = await api(page, 'POST', '/transactions/hold', { employee_id: 1, branch_id: 1, items: [{ product_id: p.id, product_name: p.name, quantity: 2, unit_price: p.price, tax_rate: p.tax_rate || 0 }], notes: note });
    await openPos(page);
    await page.evaluate(() => App.recallOrder());
    await page.locator('.modal div[onclick^="App.loadHeldOrder"]', { hasText: hold.transaction_number }).click();
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();

    const before = (await api(page, 'GET', '/quotations?limit=500')).length;
    await page.evaluate(() => App.posCreateQuoteFromCart());
    await page.locator('.modal button', { hasText: 'Create Quote' }).click();
    await expect(page.locator('.alert-success', { hasText: 'Quotation created' }).last()).toBeVisible();

    // The quote has the ticket's line; the screen is ready for a new ticket.
    const quotes = await api(page, 'GET', '/quotations?limit=500');
    expect(quotes.length).toBe(before + 1);
    await expect(page.locator('.pos-ticket-row')).toHaveCount(0);
    expect(await page.evaluate(() => App.cart.length)).toBe(0);
    await expect(page.locator('#pos-item-input')).toBeVisible();
    expect(await stillHeld(page, hold.id)).toBeUndefined();
  });

  test('closing the quote form without saving keeps the ticket', async ({ page }) => {
    const p = await product(page);
    await openPos(page);
    await page.evaluate(id => App.addToCart(id, null, 1), p.id);
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();

    await page.evaluate(() => App.posCreateQuoteFromCart());
    await page.locator('.modal .modal-close').click();
    await expect(page.locator('.pos-ticket-row')).toHaveCount(1);

    // A quote made later from the Quotations screen doesn't touch the ticket.
    await page.evaluate(() => App.showQuoteForm());
    expect(await page.evaluate(() => App._quoteFromPosCart)).toBe(false);
  });
});
