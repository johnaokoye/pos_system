import { test, expect } from './fixtures.js';

let n = 0;
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const refused = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'allowed', e => e.message), [method, url, data]);
const csvHeader = (page, url) => page.evaluate(u => fetch(`/api${u}`).then(r => r.text()).then(t => t.split(/\r?\n/)[0]), url);

// What the Security Group editor saves when only these inventory boxes are
// ticked: the module on, every sub-key written out.
const INV_SUBS = ['inventory_view', 'inventory_add', 'inventory_edit', 'inventory_delete', 'inventory_adjust', 'inventory_print_labels', 'inventory_merge', 'inventory_export', 'inventory_missing_data', 'inventory_template', 'inventory_import', 'inventory_import_history', 'inventory_scan_images', 'inventory_categories', 'inventory_brands', 'inventory_units'];
const invPerms = (ticked, extra = {}) => ({ inventory: true, ...Object.fromEntries(INV_SUBS.map(k => [k, ticked.includes(k)])), ...extra });

async function signInWith(page, permissions) {
  const stamp = `${Date.now()}${++n}`;
  const group = await api(page, 'POST', '/security-groups', { name: `Inv ${stamp}`, description: '', permissions });
  const username = `inv${stamp}`;
  await api(page, 'POST', '/employees', { first_name: 'Inv', last_name: 'Test', username, pin: stamp.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

const retailProduct = page => page.evaluate(() => App.api('GET', '/products?is_service=0&is_rental=0&is_non_inventory=0').then(ps => ps.find(p => p.cost > 0)));
const openScreen = async page => {
  await page.evaluate(() => App.showSection('inventory'));
  await expect(page.locator('#inv-tbody tr').first()).toBeVisible();
};

test.describe('View Retail Inventory', () => {
  test('is on no seeded group', async ({ page }) => {
    const groups = await api(page, 'GET', '/security-groups');
    for (const g of groups) expect(JSON.parse(typeof g.permissions === 'string' ? g.permissions : JSON.stringify(g.permissions)).inventory_view).toBeFalsy();
  });

  test('ticking the box in the Security Group editor opens the screen read only', async ({ page }) => {
    const product = await retailProduct(page);
    const stamp = `${Date.now()}${++n}`;
    await page.evaluate(() => App.showSecurityGroupForm());
    await page.fill('#sg-name', `View ${stamp}`);
    await page.check('#perm-inventory_view');
    await page.click('.modal-footer .btn-primary');
    await expect(page.locator('#sg-name')).toHaveCount(0);
    const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === `View ${stamp}`);
    const username = `view${stamp}`;
    await api(page, 'POST', '/employees', { first_name: 'View', last_name: 'Only', username, pin: stamp.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
    await page.context().clearCookies();
    await page.goto('/');
    await page.fill('#login-user', username);
    await page.fill('#login-pass', 'pw-123456');
    await page.click('button.login-btn');
    await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
    await openScreen(page);

    await expect(page.locator('#inv-tbody tr').first()).toBeVisible();
    await expect(page.locator('th', { hasText: /^Cost$/ })).toHaveCount(0);
    await expect(page.locator('button:has-text("Add Product")')).toHaveCount(0);
    await expect(page.locator('#inv-tbody button:has-text("Edit")')).toHaveCount(0);
    await expect(page.locator('#inv-tbody button:has-text("Stock")')).toHaveCount(0);
    await expect(page.locator('button:has-text("Bulk")')).toHaveCount(0);
    await expect(page.locator('#inv-tbody button:has-text("View")').first()).toBeVisible();

    // The card and stock history still work.
    await page.locator('#inv-tbody button:has-text("View")').first().click();
    await expect(page.locator('.modal-title').first()).toBeVisible();
    expect(await page.locator('.modal').first().innerText()).not.toMatch(/\bCost\b/);
    await expect(page.locator('.modal button:has-text("Edit")')).toHaveCount(0);
    await page.evaluate(() => App.closeModal());
    await page.evaluate(id => App.toggleProductHistory(id), product.id);
    expect(await refused(page, 'GET', `/products/${product.id}/movements`)).toBe('allowed');

    // Cost isn't in what the server sends either.
    const list = await api(page, 'GET', '/products');
    expect(list.length).toBeGreaterThan(0);
    expect(list.some(p => 'cost' in p)).toBe(false);
    expect('cost' in await api(page, 'GET', `/products/${product.id}`)).toBe(false);
    expect((await api(page, 'GET', `/products/${product.id}/variations`)).some(v => 'cost' in v)).toBe(false);

    // And nothing can be changed.
    expect(await refused(page, 'PUT', `/products/${product.id}`, product)).toContain('inventory_edit');
    expect(await refused(page, 'POST', '/products', { sku: `X${Date.now()}`, name: 'No', price: 1 })).toContain('inventory_add');
    expect(await refused(page, 'DELETE', `/products/${product.id}`)).toContain('inventory_delete');
    expect(await refused(page, 'POST', '/products/bulk-tax-rate', { branch_id: 1, tax_rate: 0 })).toContain('inventory_edit');
    expect(await refused(page, 'POST', `/products/${product.id}/variations`, { name: 'V', sku: `V${Date.now()}` })).toContain('inventory_add');
    expect(await refused(page, 'PATCH', `/products/${product.id}/stock`, { adjustment: 1, reason: 'x' })).toContain('inventory_adjust');
    expect((await api(page, 'GET', `/products/${product.id}`)).price).toBe(product.price);
  });

  test('an export-only person gets the CSV without cost; an editor gets it with', async ({ page }) => {
    const product = await retailProduct(page);
    await signInWith(page, invPerms(['inventory_export', 'inventory_missing_data']));
    expect(await csvHeader(page, '/products/export')).not.toContain('cost');
    expect(await csvHeader(page, '/products/export/issues')).not.toContain('cost');
    expect(await refused(page, 'PUT', `/products/${product.id}`, product)).toContain('inventory_edit');

    await page.context().clearCookies();
    await page.goto('/');
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', '123456');
    await page.click('button.login-btn');
    await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
    expect(await csvHeader(page, '/products/export')).toContain('cost');
  });

  test('Edit Products alone: sees cost and can save, but not add or delete', async ({ page }) => {
    const product = await retailProduct(page);
    await signInWith(page, invPerms(['inventory_edit']));
    await openScreen(page);
    await expect(page.locator('th', { hasText: /^Cost$/ })).toBeVisible();
    await expect(page.locator('#inv-tbody button:has-text("Edit")').first()).toBeVisible();
    await expect(page.locator('button:has-text("Add Product")')).toHaveCount(0);

    const full = await api(page, 'GET', `/products/${product.id}`);
    expect(full.cost).toBe(product.cost);
    expect(await refused(page, 'PUT', `/products/${product.id}`, full)).toBe('allowed');
    expect((await api(page, 'GET', `/products/${product.id}`)).cost).toBe(product.cost);
    expect(await refused(page, 'POST', '/products', { sku: `X${Date.now()}`, name: 'No', price: 1 })).toContain('inventory_add');
    expect(await refused(page, 'DELETE', `/products/${product.id}`)).toContain('inventory_delete');
  });

  test('other screens keep cost: view-only plus purchasing hides it here, not in the data purchasing needs', async ({ page }) => {
    const product = await retailProduct(page);
    await signInWith(page, invPerms(['inventory_view'], { purchasing: true }));
    expect((await api(page, 'GET', `/products/${product.id}`)).cost).toBe(product.cost);
    await openScreen(page);
    await expect(page.locator('th', { hasText: /^Cost$/ })).toHaveCount(0);
  });

  test('someone with no inventory access is unchanged, and POS margin still works', async ({ page }) => {
    const product = await retailProduct(page);
    await signInWith(page, { pos: true, pos_view_margin: true });
    expect((await api(page, 'GET', `/products/${product.id}`)).cost).toBe(product.cost);
    await signInWithAdmin(page);
    await signInWith(page, { pos: true });
    expect((await api(page, 'GET', `/products/${product.id}`)).cost).toBe(product.cost);
  });

  test('Administrator keeps full access', async ({ page }) => {
    await openScreen(page);
    await expect(page.locator('th', { hasText: /^Cost$/ })).toBeVisible();
    await expect(page.locator('button:has-text("Add Product")')).toBeVisible();
    await expect(page.locator('#inv-tbody button:has-text("Edit")').first()).toBeVisible();
  });
});

async function signInWithAdmin(page) {
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', '123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}
