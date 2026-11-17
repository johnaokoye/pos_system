import { test, expect } from './fixtures.js';

// The company logo is painted on the Home page vehicles — also when Home is
// drawn straight after sign-in, before the settings have loaded.
test('Home vehicles carry the company logo after signing in', async ({ page }) => {
  const before = await page.evaluate(() => App.api('GET', '/settings'));
  await page.evaluate(() => App.api('PUT', '/settings', { company_logo_url: '/favicon.ico' }));
  try {
    await page.goto('about:blank');
    await page.context().clearCookies();
    await page.goto('/');
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', '123456');
    await page.click('button.login-btn');
    await page.waitForFunction(() => App.currentUser && App.section === 'home');
    await expect(page.locator('.home-veh .logo image')).toHaveCount(5);
    expect(await page.locator('.home-veh .logo image').first().getAttribute('href')).toContain('/favicon.ico');
  } finally {
    await page.evaluate(v => App.api('PUT', '/settings', { company_logo_url: v || '' }), before.company_logo_url);
  }
});
