import { test, expect } from './fixtures.js';

// Starting consignment tracking and recording supplier-owned stock found on
// hand are Consignment sub-permissions (consignment_go_live,
// consignment_opening_record), not Settings — off for every group until
// ticked. Runs after consignment-opening.spec.js (alphabetical), so tracking
// has started; go-live is only ever refused here.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
let n = 0;
const stamp = () => `${Date.now()}${++n}`;
const perms = g => typeof g.permissions === 'string' ? JSON.parse(g.permissions) : g.permissions;

async function signIn(page, username, password = 'pw-123456') {
  // Leave the page first: a request still in flight from the last screen
  // would renew the old session cookie after it's cleared.
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

test('the seeded groups start with both off, Settings or not', async ({ page }) => {
  const groups = await api(page, 'GET', '/security-groups');
  for (const name of ['Manager', 'Cashier']) {
    const p = perms(groups.find(g => g.name === name));
    expect(p.consignment_go_live).toBe(false);
    expect(p.consignment_opening_record).toBe(false);
  }
});

test('each action needs its own Consignment permission, not Settings', async ({ page }) => {
  const s = stamp();
  // Consignment and Settings, but neither new key.
  const base = { consignment: true, settings: true, consignment_go_live: false, consignment_opening_record: false };
  const group = await api(page, 'POST', '/security-groups', { name: `Cons Perms ${s}`, permissions: base });
  const username = `cp${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Cons', last_name: `Perms${s}`, username, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  const setPerms = async p => { await api(page, 'PUT', `/security-groups/${group.id}`, { name: group.name, permissions: { ...base, ...p } }); };

  await signIn(page, username);
  // Viewing the list still only needs consignment access.
  expect(await attempt(page, 'GET', '/consignment/opening-stock')).toBe('accepted');
  expect(await attempt(page, 'GET', '/consignment/opening-candidates')).toContain('Missing permission');
  expect(await attempt(page, 'POST', '/consignment/opening-stock', {})).toContain('Missing permission: consignment_opening_record');
  expect(await attempt(page, 'POST', '/consignment/go-live', { confirm: 'START' })).toContain('Missing permission: consignment_go_live');
  await page.evaluate(() => App.showSection('consignment'));
  await page.evaluate(() => App.renderConsignment('stock'));
  await expect(page.locator('button', { hasText: 'Supplier stock found on hand' })).toBeVisible();
  await expect(page.locator('button', { hasText: '+ Record supplier-owned stock' })).toHaveCount(0);

  // Record only: the button and the form's data; go-live still refused.
  // (An empty body gets past the permission and fails validation instead.)
  await signIn(page, 'admin', '123456');
  await setPerms({ consignment_opening_record: true });
  await signIn(page, username);
  expect(await attempt(page, 'GET', '/consignment/opening-candidates')).toBe('accepted');
  expect(await attempt(page, 'POST', '/consignment/opening-stock', {})).not.toContain('Missing permission');
  expect(await attempt(page, 'POST', '/consignment/go-live', { confirm: 'START' })).toContain('Missing permission: consignment_go_live');
  await page.evaluate(() => App.showSection('consignment'));
  await page.evaluate(() => App.renderConsignment('stock'));
  await expect(page.locator('button', { hasText: '+ Record supplier-owned stock' })).toBeVisible();

  // Start Tracking only: the form's data, but not recording.
  await signIn(page, 'admin', '123456');
  await setPerms({ consignment_go_live: true });
  await signIn(page, username);
  expect(await attempt(page, 'GET', '/consignment/opening-candidates')).toBe('accepted');
  expect(await attempt(page, 'POST', '/consignment/opening-stock', {})).toContain('Missing permission: consignment_opening_record');
});
