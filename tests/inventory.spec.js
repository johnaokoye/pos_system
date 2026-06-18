import { test, expect } from './fixtures.js';

test.describe('Inventory', () => {
  test.beforeEach(async ({ page }) => {
    await page.click('[data-section="inventory"]');
    await expect(page.locator('text=Inventory').first()).toBeVisible({ timeout: 8_000 });
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
});
