import { test, expect } from './fixtures.js';

// Runs last (zz-): after every other spec has sold, returned, received,
// transferred, counted and adjusted stock with consignment tracking on, the
// stock receipts must still add up to each branch's stock figure. A
// mismatch means a stock path that doesn't keep them in step
// (lib/stockLots.js).
test('stock receipts still match every branch stock figure', async ({ page }) => {
  const check = await page.evaluate(() => App.api('GET', '/consignment/lot-check'));
  expect(check.go_live).toBeTruthy();
  expect(check.mismatches).toEqual([]);
});
