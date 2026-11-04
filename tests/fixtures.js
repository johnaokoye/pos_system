import { test as base } from '@playwright/test';

// Extends base test with a `page` that is already logged in as admin, on Home.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.goto('/');
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', '123456');
    await page.click('button.login-btn');
    await page.locator('.nav-item.active[data-section="home"]').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
    await use(page);
  },
});

export { expect } from '@playwright/test';
