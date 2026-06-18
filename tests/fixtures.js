import { test as base } from '@playwright/test';

// Extends base test with a `page` that is already logged in as admin.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.goto('/');
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', '123456');
    await page.click('button.login-btn');
    await page.waitForSelector('.stat-card', { timeout: 20_000 });
    await use(page);
  },
});

export { expect } from '@playwright/test';
