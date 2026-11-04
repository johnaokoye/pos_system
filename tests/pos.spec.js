import { test, expect } from './fixtures.js';

test.describe('Point of Sale', () => {
  test.beforeEach(async ({ page }) => {
    // The sidebar nests POS under a collapsible "Sales" hub rather than
    // exposing a top-level [data-section="pos"] nav item, so drive
    // navigation through the app's own router instead of a selector that
    // no longer matches anything.
    await page.evaluate(() => App.showSection('pos'));
    await page.waitForTimeout(800);
    // The "Open Cash Drawer" modal overlays the entire POS — remove it via JS (same as clicking Skip)
    await page.evaluate(() => document.getElementById('pos-drawer-overlay')?.remove());
    await page.locator('#pos-drawer-overlay').waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {});
  });

  test('POS shows the ticket table and action grid beside the app menu', async ({ page }) => {
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('.pos-ticket-table')).toBeVisible();
    await expect(page.locator('.pos-action-grid')).toBeVisible();
    await expect(page.locator('#pos-item-input')).toBeVisible();
  });

  test('Item Lookup modal loads the product grid', async ({ page }) => {
    await page.click('button:has-text("Item Lookup")');
    const products = page.locator('[onclick*="addToCart"], .product-card');
    await expect(products.first()).toBeVisible({ timeout: 8_000 });
    expect(await products.count()).toBeGreaterThan(0);
  });

  test('search filters the product grid inside Item Lookup', async ({ page }) => {
    await page.click('button:has-text("Item Lookup")');
    const search = page.locator('#pos-search');
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

  test('adding a product via Item Lookup puts it in the ticket', async ({ page }) => {
    await page.click('button:has-text("Item Lookup")');
    // Exclude variant products (open a secondary modal instead of adding
    // directly) and out-of-stock ones (addToCart silently no-ops on those)
    const firstSimple = page.locator('.product-card:not(.has-vars):not(.out-of-stock)').first();
    await firstSimple.click();
    await page.waitForTimeout(800);
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Cart is empty')).toBeHidden();
  });

  test('typing an item number adds it to the ticket', async ({ page }) => {
    const sku = await page.evaluate(() => App.allProducts.find(p => !p.is_service && p.stock_qty > 0 && !p.has_variations)?.sku);
    expect(sku).toBeTruthy();
    await page.fill('#pos-item-input', sku);
    await page.press('#pos-item-input', 'Enter');
    await page.waitForTimeout(500);
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Cart is empty')).toBeHidden();
  });

  test('Cancel Ticket empties the cart', async ({ page }) => {
    page.on('dialog', d => d.accept());
    await page.click('button:has-text("Item Lookup")');
    const firstSimple = page.locator('.product-card:not(.has-vars):not(.out-of-stock)').first();
    await firstSimple.click();
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible({ timeout: 5_000 });
    // Item Lookup stays open after adding (so multiple items can be picked
    // in one browse) — close it before reaching for a grid button behind it.
    await page.click('.modal-close');
    await page.click('button:has-text("Cancel Ticket")');
    await page.waitForTimeout(300);
    await expect(page.locator('text=Cart is empty')).toBeVisible();
  });

  test('a cash sale completes and shows the receipt', async ({ page }) => {
    const sku = await page.evaluate(() => App.allProducts.find(p => !p.is_service && p.stock_qty > 0 && !p.has_variations)?.sku);
    await page.fill('#pos-item-input', sku);
    await page.press('#pos-item-input', 'Enter');
    await expect(page.locator('.pos-ticket-row').first()).toBeVisible();
    await page.evaluate(() => { App.processPayment('cash'); });
    await page.fill('#ctm-tendered', '100000');
    await page.click('#ctm-confirm');
    await expect(page.locator('.modal-title', { hasText: 'Receipt' })).toBeVisible();
    await expect(page.locator('text=Cart is empty')).toBeVisible();
  });

  test('Exit button leaves the POS kiosk layout and restores app chrome', async ({ page }) => {
    await page.click('.pos-kiosk-exit');
    await page.waitForTimeout(500);
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#topbar')).toBeVisible();
  });
});
