import { test, expect } from './fixtures.js';

// The list of supplier-owned items: Consignment Stock filters/search/CSV, and
// Retail Inventory's Consignment badge and filter.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function login(page, username, password = 'pw-123456') {
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

test('consignment items listed apart: stock tab filters and CSV, inventory badge and filter', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const groups = await api(page, 'GET', '/security-groups');
  const finance = `csl${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Csl', last_name: 'Finance', username: finance, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 });
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });

  const consigned = await api(page, 'POST', '/products', { name: `Listed Drill ${s}`, sku: `LD${s}`, price: 200, cost: 80, tax_rate: 0, stock_qty: 0, active: 1 });
  const owned = await api(page, 'POST', '/products', { name: `Listed Drill Owned ${s}`, sku: `LO${s}`, price: 200, cost: 80, tax_rate: 0, stock_qty: 0, active: 1 });
  await api(page, 'PATCH', `/products/${owned.id}/stock`, { adjustment: 4, reason: 'owned', branch_id: main.id });
  await api(page, 'PATCH', `/products/${consigned.id}/stock`, { adjustment: 1, reason: 'owned', branch_id: main.id });

  const sup = await api(page, 'POST', '/suppliers', { name: `Listing Supplier ${s}` });
  const a = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2026-01-01', ownership_terms: "Supplier's until sold", items: [{ product_id: consigned.id, cost: 75 }], submit: true });
  await login(page, finance);
  await api(page, 'POST', `/consignment/agreements/${a.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${a.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  const o = await api(page, 'POST', '/consignment/orders', { agreement_id: a.id, branch_id: main.id, items: [{ product_id: consigned.id, quantity: 3 }] });
  const g = await api(page, 'POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: `DN-L${s}`, items: [{ order_item_id: o.items[0].id, quantity: 3 }] });
  await api(page, 'POST', `/consignment/grns/${g.id}/approve`, {});

  // API: search and branch filter.
  let stock = await api(page, 'GET', `/consignment/stock?q=${encodeURIComponent(`LD${s}`)}`);
  expect(stock.rows.map(r => [r.sku, r.qty_on_hand, r.agreed_cost, r.value])).toEqual([[`LD${s}`, 3, 75, 225]]);
  expect((await api(page, 'GET', `/consignment/stock?q=LD${s}&branch_id=${other.id}`)).rows).toHaveLength(0);

  // Screen: supplier filter narrows the list; CSV has the row.
  await page.evaluate(() => App.renderConsignment('stock'));
  await page.locator('#cs-supplier').selectOption(String(sup.id));
  await expect(page.locator('#cons-stock-table tbody tr')).toHaveCount(1);
  await expect(page.locator('#cons-stock-table')).toContainText(consigned.name);
  await expect(page.locator('#cs-agreement option')).toHaveText(['All Agreements', a.agreement_number]);
  const download = page.waitForEvent('download');
  await page.click('button:has-text("CSV")');
  const file = await (await download).path();
  const csv = require('fs').readFileSync(file, 'utf8');
  expect(csv).toContain(`"LD${s}"`);
  expect(csv).toContain('"225"');
  await page.fill('#cs-q', `nothing-${s}`);
  await expect(page.locator('#cons-stock-table')).toContainText('No supplier-owned stock matches these filters');

  // Products API: consignment_qty and the filter.
  const rows = await api(page, 'GET', `/products?search=${s}&is_rental=0`);
  expect(rows.find(p => p.id === consigned.id).consignment_qty).toBe(3);
  expect(rows.find(p => p.id === owned.id).consignment_qty).toBe(0);
  expect((await api(page, 'GET', `/products?search=${s}&consignment=1`)).map(p => p.id)).toEqual([consigned.id]);
  expect((await api(page, 'GET', `/products?search=${s}&consignment=0`)).map(p => p.id)).toEqual([owned.id]);
  expect((await api(page, 'GET', `/products?search=${s}&consignment=1&branch_id=${other.id}`))).toHaveLength(0);
  expect((await api(page, 'GET', `/products?search=${s}&consignment=1&branch_id=${main.id}`)).map(p => [p.id, p.consignment_qty, p.stock_qty])).toEqual([[consigned.id, 3, 4]]);

  // Retail Inventory: badge on the item, filter shows only it.
  await page.evaluate(() => App.showSection('inventory'));
  await page.fill('#inv-search', s);
  await page.locator('#inv-search').press('Enter');
  await expect(page.locator(`#inv-row-${consigned.id}`)).toContainText('Consignment 3');
  await expect(page.locator(`#inv-row-${owned.id}`)).not.toContainText('Consignment');
  await page.locator('#inv-owner-filter').selectOption('1');
  await expect(page.locator(`#inv-row-${owned.id}`)).toHaveCount(0);
  await expect(page.locator(`#inv-row-${consigned.id}`)).toBeVisible();
});
