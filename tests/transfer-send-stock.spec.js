import { test, expect } from './fixtures.js';

// Review & Send on a transfer request: stock fixed elsewhere shows without
// reloading, and can be adjusted on the line — typed quantities are kept.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('send transfer: refresh and adjust stock in place, keeping typed quantities', async ({ page }) => {
  const stamp = Date.now();
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0 && !Number(b.is_warehouse));
  const mk = n => api(page, 'POST', '/products', { sku: `TSS${n}-${stamp}`, name: `Send Stock ${n} ${stamp}`, price: 10, cost: 5, tax_rate: 0 });
  const a = await mk('A'), b = await mk('B');
  await api(page, 'PATCH', `/products/${a.id}/stock`, { adjustment: 3, branch_id: main.id, reason: 'test' });
  await api(page, 'PATCH', `/products/${b.id}/stock`, { adjustment: 1, branch_id: main.id, reason: 'test' });
  const tr = await api(page, 'POST', '/transfers', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: a.id, quantity: 5 }, { product_id: b.id, quantity: 4 }] });
  const t = await api(page, 'GET', `/transfers/${tr.id}`);
  const [la, lb] = [a, b].map(p => t.items.find(i => i.product_id === p.id));

  await page.evaluate(id => App.showSendTransfer(id), tr.id);
  await expect(page.locator(`#tsend-stock-${la.id}`)).toHaveText('3');
  await expect(page.locator(`#tsend-${la.id}`)).toHaveValue('3');
  await page.fill(`#tsend-${lb.id}`, '1'); // typed by hand — must survive

  // Someone fixes A's count in another tab; Refresh shows it without losing the screen.
  await api(page, 'PATCH', `/products/${a.id}/stock`, { adjustment: 4, branch_id: main.id, reason: 'recount' });
  await page.getByRole('button', { name: '↻ Refresh stock' }).click();
  await expect(page.locator(`#tsend-stock-${la.id}`)).toHaveText('7');
  await expect(page.locator(`#tsend-${la.id}`)).toHaveValue('5'); // untouched line takes the new default
  await expect(page.locator(`#tsend-${lb.id}`)).toHaveValue('1');

  // Adjust B right on the line: counted 6.
  await page.locator('.po-receive-row', { hasText: `Send Stock B ${stamp}` }).getByRole('link', { name: 'Adjust' }).click();
  await page.fill(`#tsend-adj-qty-${lb.id}`, '6');
  await page.fill(`#tsend-adj-reason-${lb.id}`, 'Recount while picking');
  await page.click(`#tsend-adj-btn-${lb.id}`);
  await expect(page.locator(`#tsend-stock-${lb.id}`)).toHaveText('6');
  await expect(page.locator(`#tsend-${lb.id}`)).toHaveValue('1'); // still what was typed
  const moves = await api(page, 'GET', `/products/${b.id}/movements`);
  expect(moves.some(m => m.qty === 5 && /Recount while picking/.test(m.detail))).toBeTruthy();

  await page.fill(`#tsend-${lb.id}`, '4');
  await page.click('#tsend-btn');
  await expect(page.locator('#tsend-btn')).toHaveCount(0);
  const sent = await api(page, 'GET', `/transfers/${tr.id}`);
  expect(sent.status).toBe('pending');
  expect(sent.items.find(i => i.id === la.id).quantity_requested).toBe(5);
  expect(sent.items.find(i => i.id === lb.id).quantity_requested).toBe(4);
});
