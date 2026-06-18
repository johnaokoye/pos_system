import { test, expect } from './fixtures.js';

test.describe('Dashboard', () => {
  test('shows four stat cards', async ({ page }) => {
    const cards = page.locator('.stat-card');
    await expect(cards).toHaveCount(4);
  });

  test('stat cards have expected labels', async ({ page }) => {
    // CSS applies text-transform:uppercase visually; raw text content is title-cased
    const labels = await page.locator('.stat-label').allTextContents();
    const normalized = labels.map(l => l.trim().toLowerCase());
    expect(normalized).toEqual(
      expect.arrayContaining(["today's sales", 'month to date', 'total customers', 'low stock items'])
    );
  });

  test('recent transactions table is present', async ({ page }) => {
    await expect(page.locator('text=Recent Transactions')).toBeVisible();
  });

  test('sales by location section renders', async ({ page }) => {
    await expect(page.locator('text=Sales by Location')).toBeVisible();
  });
});
