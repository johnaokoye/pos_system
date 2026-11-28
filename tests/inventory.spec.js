import { test, expect } from './fixtures.js';

test.describe('Inventory', () => {
  test.beforeEach(async ({ page }) => {
    // Inventory sits under a hub, so go through the app's router as pos.spec.js does.
    await page.evaluate(() => App.showSection('inventory'));
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 8_000 });
  });

  test('product table has rows', async ({ page }) => {
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('search filters the product list', async ({ page }) => {
    const allRows = await page.locator('table tbody tr').count();
    const search = page.locator('input[placeholder*="Search products"]');
    await search.fill('Baseball');
    await page.waitForTimeout(600);
    const filteredRows = await page.locator('table tbody tr').count();
    expect(filteredRows).toBeLessThan(allRows);
    expect(filteredRows).toBeGreaterThanOrEqual(1);
  });

  test('Add Product button is visible', async ({ page }) => {
    await expect(page.locator('button:has-text("Add Product")')).toBeVisible();
  });

  test('category filter dropdown is present', async ({ page }) => {
    // "All Categories" is an <option> inside a <select> — check the select itself
    const select = page.locator('select').filter({ hasText: 'All Categories' });
    await expect(select).toBeVisible();
  });

  test('supplier filter lists only that supplier\'s items, and No supplier the rest', async ({ page }) => {
    const s = Date.now().toString(36);
    const api = (m, u, b) => page.evaluate(([m, u, b]) => App.api(m, u, b), [m, u, b]);
    const sup = await api('POST', '/suppliers', { name: `Filter Supplier ${s}` });
    const mk = (tag, supplier_id) => api('POST', '/products', { sku: `SUPF-${tag}-${s}`, name: `SupFilter ${tag} ${s}`, price: 10, cost: 5, supplier_id });
    const withSup = await mk('A', sup.id);
    const noSup = await mk('B', null);

    // API
    const ids = async q => (await api('GET', `/products?search=SupFilter&is_rental=0${q}`)).filter(p => p.name.endsWith(s)).map(p => p.id);
    expect(await ids(`&supplier_id=${sup.id}`)).toEqual([withSup.id]);
    expect(await ids('&supplier_id=none')).toEqual([noSup.id]);

    // Screen (re-rendered so the new supplier is in the box)
    await page.evaluate(() => App.renderInventory('all'));
    await page.fill('#inv-search', `SupFilter`);
    await page.locator('#inv-search').press('Enter');
    await expect(page.locator(`#inv-row-${noSup.id}`)).toBeVisible();
    await page.locator('#inv-supplier-filter').selectOption(String(sup.id));
    await expect(page.locator(`#inv-row-${noSup.id}`)).toHaveCount(0);
    await expect(page.locator(`#inv-row-${withSup.id}`)).toBeVisible();
    await page.locator('#inv-supplier-filter').selectOption('none');
    await expect(page.locator(`#inv-row-${withSup.id}`)).toHaveCount(0);
    await expect(page.locator(`#inv-row-${noSup.id}`)).toBeVisible();
    // Kept across a re-render onto saved filters
    const state = await page.evaluate(() => App._invFilterState());
    expect(state.supplier).toBe('none');
  });
});
