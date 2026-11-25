import { test, expect } from './fixtures.js';

test.describe('Dashboard', () => {
  // Home is the first screen after login; the dashboard is one click on.
  test.beforeEach(async ({ page }) => {
    await page.click('.nav-item[data-section="dashboard"]');
    await page.locator('.stat-card').first().waitFor();
  });

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

  // The location cards are on the same store day and month as the headline
  // (they used the UTC day, so they didn't add up from 7pm Jamaica time on).
  test('sales by location add up to today\'s and month-to-date sales', async ({ page }) => {
    const d = await page.evaluate(() => App.api('GET', '/reports/dashboard'));
    const sum = k => Math.round(d.byLocation.reduce((s, l) => s + l[k], 0) * 100) / 100;
    expect(sum('today_sales')).toBeCloseTo(d.todayStats.sales, 2);
    expect(sum('today_transactions')).toBe(d.todayStats.transactions);
    expect(sum('month_sales')).toBeCloseTo(d.monthStats.sales, 2);
    expect(sum('month_transactions')).toBe(d.monthStats.transactions);
  });
});
