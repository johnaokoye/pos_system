import { test, expect } from './fixtures.js';

test.describe('Point of Sale', () => {
  test.beforeEach(async ({ page }) => {
    await page.click('[data-section="pos"]');
    await page.waitForTimeout(800);
    // The "Open Cash Drawer" modal overlays the entire POS — remove it via JS (same as clicking Skip)
    await page.evaluate(() => document.getElementById('pos-drawer-overlay')?.remove());
    await page.locator('#pos-drawer-overlay').waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {});
  });

  test('product grid loads with items', async ({ page }) => {
    // Products are rendered as clickable cards
    const products = page.locator('[onclick*="addToCart"], .product-card');
    await expect(products.first()).toBeVisible({ timeout: 8_000 });
    expect(await products.count()).toBeGreaterThan(0);
  });

  test('search filters product grid', async ({ page }) => {
    const search = page.locator('input[placeholder*="Search products"]');
    await expect(search).toBeVisible();
    await search.fill('Baseball Cap');
    await page.waitForTimeout(600);
    const products = page.locator('[onclick*="addToCart"], .product-card');
    const count = await products.count();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThan(10);
  });

  test('cart is initially empty', async ({ page }) => {
    await expect(page.locator('text=Cart is empty')).toBeVisible();
  });

  test('adding a product puts it in the cart', async ({ page }) => {
    // Use :not(.has-vars) — variant products open a secondary modal instead of adding directly
    const firstSimple = page.locator('[onclick*="addToCart"]:not(.has-vars)').first();
    await firstSimple.click();
    await page.waitForTimeout(800);
    await expect(page.locator('.cart-item').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Cart is empty')).toBeHidden();
  });

  test('clear button empties the cart', async ({ page }) => {
    const firstSimple = page.locator('[onclick*="addToCart"]:not(.has-vars)').first();
    await firstSimple.click();
    await expect(page.locator('.cart-item').first()).toBeVisible({ timeout: 5_000 });
    await page.click('button:has-text("Clear")');
    await page.waitForTimeout(300);
    await expect(page.locator('text=Cart is empty')).toBeVisible();
  });
});
