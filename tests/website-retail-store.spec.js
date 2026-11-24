import { test, expect } from './fixtures.js';

// Settings → Website → Online Retail Store: the website's shop shows that
// branch's stock and its orders (API key, no branch) are raised there.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('the website shop sells from the Online Retail Store', async ({ page }) => {
  const s = `${Date.now()}`;
  const main = (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const store = await api(page, 'POST', '/branches', { name: `Web Store ${s}`, city: 'Ocho Rios', active: 1 });
  const item = await api(page, 'POST', '/products', { sku: `WEB-${s}`, name: `Web Drill ${s}`, price: 100, branch_id: main.id, stock_qty: 7, online_available: 1 });
  // 3 of them at the web store too.
  await api(page, 'POST', '/transfers/quick', { from_branch_id: main.id, to_branch_id: store.id, items: [{ product_id: item.id, quantity: 3 }] }).catch(async () => {
    await api(page, 'PATCH', `/products/${item.id}/stock`, { branch_id: store.id, stock_qty: 3, reason: 'test' });
  });
  const key = (await api(page, 'POST', '/api-keys', { name: `Shop ${s}`, scopes: ['*'] })).key;
  const get = async url => (await page.request.get(`/api/${url}`, { headers: { 'X-API-Key': key } })).json();

  try {
    // Choose it in Settings → Website.
    await page.evaluate(() => App.showSection('settings'));
    await page.locator('#s-website-retail-branch').selectOption(String(store.id));
    await page.locator('#s-website-retail-branch').locator('xpath=ancestor::div[contains(@class,"card")]').locator('button:has-text("Save")').click();
    await expect.poll(async () => (await get('settings/website')).website_retail_branch_id).toBe(store.id);
    expect((await get('settings/website')).retail_branch).toMatchObject({ id: store.id, name: `Web Store ${s}` });

    // Its stock is what the website sees.
    const atStore = (await get(`products?online=1&search=WEB-${s}`))[0];
    expect(atStore.stock_qty).toBe((await api(page, 'GET', `/products?branch_id=${store.id}&search=WEB-${s}`))[0].stock_qty);
    expect((await get(`products/${item.id}?online=1`)).stock_qty).toBe(atStore.stock_qty);

    // An online order with no branch is raised there.
    const r = await page.request.post('/api/transactions', { headers: { 'X-API-Key': key }, data: {
      items: [{ product_id: item.id, quantity: 1, unit_price: 100, name: item.name }], payment_method: 'card', subtotal: 100, tax_amount: 0, total: 100,
    } });
    expect(r.status()).toBe(201);
    expect((await r.json()).branch_id).toBe(store.id);

    // An inactive branch can't be chosen.
    await api(page, 'PUT', `/branches/${store.id}`, { ...store, active: 0 });
    expect(await page.evaluate(id => App.api('PUT', '/settings/website', { website_retail_branch_id: id }).then(() => 'ok', e => e.message), store.id)).toMatch(/active branch/);
    await api(page, 'PUT', `/branches/${store.id}`, { ...store, active: 1 });
  } finally {
    await api(page, 'PUT', '/settings/website', { website_retail_branch_id: null });
  }
  // Blank: back to the Ecommerce Sync branch (none in the test database) — company-wide stock.
  expect((await get('settings/website')).website_retail_branch_id).toBe(null);
  expect((await get(`products/${item.id}?online=1`)).stock_qty).toBe((await api(page, 'GET', `/products/${item.id}`)).stock_qty);
});
