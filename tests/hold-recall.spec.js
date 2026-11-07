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
});
