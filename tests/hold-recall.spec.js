import { test, expect } from './fixtures.js';

// Hold Recall keeps the held ticket until it's sold, re-held or cancelled —
// a sale that fails (or a frozen screen) used to lose it, since recalling
// deleted it.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => `${e.status} ${e.data?.code || ''} ${e.message}`), [method, url, data]);
let n = 0;
const stamp = () => `${Date.now()}${++n}`;

const product = page => page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 20 && p.price > 0 && p.product_type !== 'service')));

async function heldTicket(page) {
  const p = await product(page);
  const note = `Hold ${stamp()}`;
  const hold = await api(page, 'POST', '/transactions/hold', { employee_id: 1, branch_id: 1, items: [{ product_id: p.id, product_name: p.name, quantity: 2, unit_price: p.price, tax_rate: p.tax_rate || 0 }], notes: note });
  return { hold, product: p };
}

const stillHeld = async (page, id) => (await api(page, 'GET', '/transactions?status=hold&limit=500')).find(h => h.id === id);

async function openPos(page) {
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts);
  await page.evaluate(() => document.getElementById('pos-drawer-overlay')?.remove());
}

// Clicks the hold's card in Hold Recall and waits until the recall has
// finished (it closes whatever modal is open when it does).
async function pickHold(page, hold) {
  await page.locator('.modal div[onclick^="App.loadHeldOrder"]', { hasText: hold.transaction_number }).click();
  await expect(page.locator('.alert-success', { hasText: 'Order recalled' }).last()).toBeVisible();
  await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
}

async function recall(page, hold) {
  await page.evaluate(() => App.recallOrder());
  await pickHold(page, hold);
}

const payCash = async page => {
  await page.evaluate(() => { App._salespersonReminderDone = true; App.processPayment('cash'); });
  await page.fill('#ctm-tendered', '100000');
  await page.click('#ctm-confirm');
};

test.describe('Hold Recall', () => {
  test('a recalled ticket stays on hold until it is sold, so a failed sale loses nothing', async ({ page }) => {
    const { hold } = await heldTicket(page);
    await openPos(page);
    await recall(page, hold);

    const opened = await stillHeld(page, hold.id);
    expect(opened).toBeTruthy();
    expect(opened.recalled_by).toBe(1);
    expect(opened.recalled_by_name).toBeTruthy();

    // The sale fails: the ticket stays on screen and on hold.
    await page.route('**/api/transactions', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'SQLITE_BUSY: database is locked' }) })
      : route.continue());
    await payCash(page);
    await expect(page.locator('.alert-error', { hasText: 'the sale was not completed' })).toBeVisible();
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
    expect(await stillHeld(page, hold.id)).toBeTruthy();
    await page.unroute('**/api/transactions');

    // The page is reloaded (frozen screen): the hold is still in Recall,
    // marked as opened, and can be finished.
    await page.reload();
    await page.waitForFunction(() => App.currentUser);
    await openPos(page);
    await page.evaluate(() => App.recallOrder());
    await expect(page.locator('.modal div[onclick^="App.loadHeldOrder"]', { hasText: hold.transaction_number })).toContainText('Opened by');
    await pickHold(page, hold);
    await payCash(page);
    await expect(page.locator('.modal-title', { hasText: 'Receipt' })).toBeVisible();

    // The sale removed the hold — and it can't be sold a second time.
    expect(await stillHeld(page, hold.id)).toBeUndefined();
    const p = await product(page);
    expect(await attempt(page, 'POST', '/transactions', { items: [{ product_id: p.id, quantity: 1 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, hold_id: hold.id })).toContain('409 hold_gone');
  });

  test('cancelling a recalled ticket removes the hold; re-holding it replaces the old one', async ({ page }) => {
    await openPos(page);
    page.on('dialog', d => d.accept());

    const first = await heldTicket(page);
    await recall(page, first.hold);
    await page.evaluate(() => App.posCancelTicket());
    await expect.poll(() => stillHeld(page, first.hold.id)).toBeUndefined();

    const second = await heldTicket(page);
    await recall(page, second.hold);
    const before = (await api(page, 'GET', '/transactions?status=hold&limit=500')).length;
    await page.evaluate(() => App.holdOrder());
    await expect(page.locator('text=Cart is empty')).toBeVisible();
    const after = await api(page, 'GET', '/transactions?status=hold&limit=500');
    expect(after.find(h => h.id === second.hold.id)).toBeUndefined();
    expect(after.length).toBe(before);
  });

  test('a ticket finished at another till warns before it is opened or charged again', async ({ page }) => {
    const { hold, product: p } = await heldTicket(page);
    await openPos(page);
    await recall(page, hold);
    // Another till sells it meanwhile.
    expect(await attempt(page, 'POST', '/transactions', { items: [{ product_id: p.id, quantity: 2 }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 100000, hold_id: hold.id })).toBe('accepted');

    let message = '';
    page.once('dialog', d => { message = d.message(); d.dismiss(); });
    await payCash(page);
    await expect.poll(() => message).toContain('no longer on hold');
    // Declined: nothing charged, ticket still on screen.
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
  });
  test('a tax-exempt ticket is held without tax and comes back exempt', async ({ page }) => {
    await openPos(page);
    const p = await product(page);
    await page.evaluate(id => App.addToCart(id, App._unitChoices(App.allProducts.find(x => x.id === id))[0]), p.id);
    await page.evaluate(() => { App._manualTaxExempt = { number: 'EX-HOLD' }; App.renderCart(); });
    await page.evaluate(() => App.holdOrder());
    await expect.poll(() => page.evaluate(() => App.cart.length)).toBe(0);
    const held = (await api(page, 'GET', '/transactions?status=hold&limit=500')).sort((a, b) => b.id - a.id)[0];
    const row = await api(page, 'GET', `/transactions/${held.id}`);
    expect(row.tax_exempt).toBe(1);
    expect(row.tax_exemption_number).toBe('EX-HOLD');
    expect(row.tax_amount).toBe(0);

    await page.evaluate(id => App.loadHeldOrder(id), held.id);
    await expect.poll(() => page.evaluate(() => App.cart.length)).toBe(1);
    expect(await page.evaluate(() => [App.isCartTaxExempt(), App.cartTaxExemptionNumber()])).toEqual([true, 'EX-HOLD']);
    await page.evaluate(() => App.clearCart());
  });

  test('a ticket discount replaces a bundle code; a bundle code comes off and back on as its pieces do', async ({ page }) => {
    await openPos(page);
    const [a, b] = await page.evaluate(() => App.allProducts.filter(p => !p.is_rental && !p.has_variations && p.stock_qty > 20 && p.price > 5 && p.product_type !== 'service' && !App._unitChoices(p).some(c => !c.isBase)).slice(0, 2).map(p => ({ id: p.id, price: p.price })));
    const code = `BND${stamp()}`;
    const { id: promoId } = await api(page, 'POST', '/promotions', { name: `Pair ${code}`, type: 'bundle', bundle_pricing: 'percent', value: 10, active: true, bundle_items: [{ product_id: a.id, quantity: 1 }, { product_id: b.id, quantity: 1 }] });
    await api(page, 'POST', `/promotions/${promoId}/codes`, { code });
    const add = id => page.evaluate(id => App.addToCart(id, App._unitChoices(App.allProducts.find(x => x.id === id))[0]), id);
    await add(a.id); await add(b.id);
    await page.evaluate(() => App._closeBundleUpsell());
    await page.evaluate(() => App.showTicketDiscountModal());
    await page.fill('#promo-code-input', code);
    await page.evaluate(() => App.applyPromoCode());
    await expect.poll(() => page.evaluate(() => App.appliedPromoCode?.code)).toBe(code);

    // Removing a piece takes the code's discount off; adding it back restores it.
    await page.evaluate(() => App.closeModal());
    await page.evaluate(() => App.removeFromCart(1));
    await expect.poll(() => page.evaluate(() => [App.appliedPromoCode, App.cartDiscount])).toEqual([null, 0]);
    await add(b.id);
    await expect.poll(() => page.evaluate(() => App.appliedPromoCode?.code)).toBe(code);
    expect(await page.evaluate(() => App.cartDiscount)).toBeGreaterThan(0);

    // A Ticket Discount replaces the code, so Hold keeps it (not the code).
    await page.evaluate(() => App.showTicketDiscountModal());
    await page.fill('#discount-input', '1');
    await page.evaluate(() => App.applyDiscount());
    expect(await page.evaluate(() => [App.appliedPromoCode, App.cartDiscount])).toEqual([null, 1]);
    await page.evaluate(() => App.closeModal());
    await page.evaluate(() => App.holdOrder());
    await expect.poll(() => page.evaluate(() => App.cart.length)).toBe(0);
    const held = (await api(page, 'GET', '/transactions?status=hold&limit=500')).sort((x, y) => y.id - x.id)[0];
    const row = await api(page, 'GET', `/transactions/${held.id}`);
    expect([row.discount_source, row.discount_amount, row.promotion_code]).toEqual(['manual', 1, null]);
    await api(page, 'DELETE', `/promotions/${promoId}`);
  });
});
