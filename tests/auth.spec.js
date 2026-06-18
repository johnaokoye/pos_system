import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('login page renders', async ({ page }) => {
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#login-user')).toBeVisible();
    await expect(page.locator('#login-pass')).toBeVisible();
    await expect(page.locator('button.login-btn')).toHaveText('Sign In');
  });

  test('wrong password shows error', async ({ page }) => {
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', 'wrongpassword');
    await page.click('button.login-btn');
    await expect(page.locator('#login-error')).toContainText(/invalid|incorrect|wrong/i);
  });

  test('admin login succeeds and shows dashboard', async ({ page }) => {
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', '123456');
    await page.click('button.login-btn');
    await expect(page.locator('.stat-card').first()).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('.nav-item.active')).toContainText('Dashboard');
    await expect(page.locator('#login-screen')).toBeHidden();
  });

  test('sign out returns to login screen', async ({ page }) => {
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', '123456');
    await page.click('button.login-btn');
    await expect(page.locator('.stat-card').first()).toBeVisible({ timeout: 8_000 });
    await page.click('button:has-text("Sign Out")');
    await expect(page.locator('#login-screen')).toBeVisible();
  });
});
