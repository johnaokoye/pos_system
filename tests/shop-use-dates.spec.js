import { test, expect } from './fixtures.js';
import { request } from '@playwright/test';

// Shop Use backdating: a request carries the day the items were actually
// asked for, and an issue its transaction date — the date it's posted to the
// cost centre / Books — instead of the day it was processed.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);

test('shop use: date requested and issue transaction date drive the posting date', async ({ page }) => {
  const stamp = Date.now();
  const today = await page.evaluate(() => App._storeDay(new Date()));
  const day = n => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const p = await api(page, 'POST', '/products', { sku: `SUD-${stamp}`, name: `Shop Use Rag ${stamp}`, price: 10, cost: 4, tax_rate: 0 });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 50, branch_id: 1, reason: 'test' });
  const body = date => ({ category: 'cleaning', branch_id: 1, source_branch_id: 1, department: 'Operations', reason: 'Cleaning the yard', requested_date: date, lines: [{ product_id: p.id, quantity: 2 }], submit: true });

  // Someone else approves (never your own request).
  const g = await api(page, 'POST', '/security-groups', { name: `SU Appr ${stamp}`, permissions: { shop_use: true, shop_use_approve: true } });
  const u = `suappr${stamp}`;
  await api(page, 'POST', '/employees', { first_name: 'Su', last_name: `Appr${stamp}`, username: u, pin: `${stamp}`.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: g.id, default_branch_id: 1, active: 1 });
  expect(await attempt(page, 'POST', '/shop-use/requests', body(day(-1)))).toMatch(/future/);
  const r1 = await api(page, 'POST', '/shop-use/requests', body(day(10)));
  const r2 = await api(page, 'POST', '/shop-use/requests', body(day(4)));
  expect(r1.requested_date).toBe(day(10));

  const ctx = await request.newContext({ baseURL: process.env.POS_TEST_URL });
  try {
    await ctx.post('/api/employees/login', { data: { username: u, password: 'pw-123456' } });
    for (const r of [r1, r2]) expect((await ctx.post(`/api/shop-use/requests/${r.id}/approve`, { data: {} })).ok()).toBeTruthy();
  } finally { await ctx.dispose(); }

  const issue = (r, date, key, qty = 2) => attempt(page, 'POST', `/shop-use/requests/${r.id}/issues`, { issue_key: `${key}-${stamp}`, lines: [{ line_id: r.lines[0].id, qty }], recipient_employee_id: 1, acknowledged: true, comments: 'rest to follow', ...(date ? { transaction_date: date } : {}) });
  expect(await issue(r1, day(11), 'early')).toMatch(/before the date requested/);
  expect(await issue(r1, day(-1), 'future')).toMatch(/future/);
  expect(await issue(r1, day(7), 'a', 1)).toBe('accepted');   // backdated to when it went out
  expect(await issue(r2, null, 'b')).toBe('accepted');     // no date given → the date requested

  const postings = await api(page, 'GET', '/shop-use/postings');
  const full1 = await api(page, 'GET', `/shop-use/requests/${r1.id}`), full2 = await api(page, 'GET', `/shop-use/requests/${r2.id}`);
  expect(full1.issues[0].transaction_date).toBe(day(7));
  expect(full2.issues[0].transaction_date).toBe(day(4));
  expect(postings.find(x => x.reference === full1.issues[0].issue_number).posting_date).toBe(day(7));
  expect(postings.find(x => x.reference === full2.issues[0].issue_number).posting_date).toBe(day(4));
  expect(full1.audit.some(a => a.action === 'issued' && a.details.includes(`"backdated_from":"${today}"`))).toBeTruthy();

  // The request can't then be re-dated after its first issue.
  const edit = { ...body(day(5)), submit: false, lines: full1.lines.map(l => ({ id: l.id, product_id: l.product_id, quantity: l.qty_requested })) };
  expect(await attempt(page, 'PUT', `/shop-use/requests/${r1.id}`, edit)).toMatch(/can't be after/);

  // The screen: the request shows its date, the issue its transaction date and when it was processed.
  await page.evaluate(id => App.viewShopUseRequest(id), r1.id);
  const dt = await page.evaluate(d => App.fmtDate(d), day(7));
  await expect(page.locator('.modal')).toContainText(dt);
  await expect(page.locator('.modal')).toContainText('processed');
  // The issue dialog starts at the date requested; a new request at today.
  await page.evaluate(id => App._suIssue(id), r1.id);
  await expect(page.locator('#su-iss-date')).toHaveValue(day(10));
  await page.evaluate(() => App.showShopUseForm());
  await expect(page.locator('#su-req-date')).toHaveValue(today);
  // Issue the rest so nothing is left waiting (its notice would cover other tests' buttons).
  await page.evaluate(() => App.closeModal());
  expect(await issue(r1, null, 'rest', 1)).toBe('accepted');
});
