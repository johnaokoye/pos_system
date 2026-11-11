import { test, expect } from './fixtures.js';
import frontendCheck from '../scripts/check-frontend.js';

const { checkFrontend } = frontendCheck;

// Every screen an admin can reach from the menus.
const SECTIONS = ['accounts', 'accounts-hub', 'admin-hub', 'assessment', 'branches', 'cash-back-cards', 'commissions',
  'crm', 'customers', 'cycle-counts', 'dashboard', 'discount-cards', 'dispatch', 'drawers', 'employees', 'home',
  'inventory', 'layaway', 'online-orders', 'payables', 'pos', 'promotions', 'purchase-requests', 'purchasing',
  'purchasing-hub', 'quotations', 'rental-deposits', 'rental-dispatch', 'rental-items', 'rentals', 'reports',
  'reports-accounts', 'reports-hub', 'reports-inventory', 'reports-marketing', 'reports-purchasing', 'reports-sales',
  'sales-hub', 'security', 'services', 'settings', 'shipping', 'shop-use', 'special-orders', 'special-projects',
  'suppliers', 'transactions', 'transfer-dispatch', 'transfers', 'user-sessions', 'warehouse', 'warehouse-hub',
  'wo-schedule', 'work-orders'];

test('public/js follows the file and member-name rules', () => {
  expect(checkFrontend().problems).toEqual([]);
});

test('every screen renders without a script error', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  let section = '';
  // The first lines of the stack, so a failure says where it came from.
  page.on('pageerror', e => errors.push(`${section}: ${e.message} @ ${String(e.stack || '').split('\n').slice(1, 4).map(l => l.trim()).join(' < ')}`));
  for (section of SECTIONS) {
    await page.evaluate(s => App.showSection(s), section);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    expect(await page.locator('#content').innerHTML(), section).not.toBe('');
  }
  expect(errors).toEqual([]);
});
