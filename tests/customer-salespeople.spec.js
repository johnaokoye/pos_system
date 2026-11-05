import { test, expect } from './fixtures.js';

const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(r => ({ ok: r }), e => ({ error: e.message })), [method, url, data]);

let n = 0;
const stamp = () => `${Date.now()}${++n}`;

async function createSalesperson(page, first) {
  const username = `sp${stamp()}`;
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Cashier');
  const e = await api(page, 'POST', '/employees', { first_name: first, last_name: `Rep${stamp()}`, username, pin: stamp().slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1, is_salesperson: 1 });
  const row = (await api(page, 'GET', '/employees')).find(x => x.id === e.id);
  if (!row.is_salesperson) await api(page, 'PUT', `/employees/${e.id}`, { ...row, is_salesperson: 1, active: 1 });
  return { id: e.id, name: `${row.first_name} ${row.last_name}`, username };
}

async function createCustomers(page, count, last = `Bulk${stamp()}`) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const s = stamp();
    out.push(await api(page, 'POST', '/customers', { first_name: `C${i}`, last_name: last, phone: s.slice(-10), customer_type: 'cash', force: true }));
  }
  return { rows: out, last };
}

const owner = async (page, id) => (await api(page, 'GET', `/customers/${id}`)).salesperson_id;

async function openScreen(page, search) {
  await page.evaluate(() => App.showSection('customers'));
  await expect(page.locator('button', { hasText: 'Assign Salespeople' })).toBeVisible();
  await page.click('button:has-text("Assign Salespeople")');
  await expect(page.locator('h2', { hasText: 'Assign Salespeople' })).toBeVisible();
  await expect(page.locator('#csa-count')).toContainText('customer');
  if (search) {
    await page.fill('#csa-search', search);
    await expect(page.locator('#csa-tbody tr').first()).toContainText(search);
  }
}

// Picks and uploads a file through the Upload Sheet control.
async function upload(page, csv, name = 'assign.csv') {
  await page.locator('input[type=file][onchange*="_csaUploadFile"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('.modal-title', { hasText: 'Review Assignments' })).toBeVisible();
}

test.describe('Assign Salespeople', () => {
  test('tick customers, review, apply, then the Customers list shows and filters them', async ({ page }) => {
    const rep = await createSalesperson(page, 'Tick');
    const { rows, last } = await createCustomers(page, 3);
    await openScreen(page, last);
    await expect(page.locator('#csa-tbody tr')).toHaveCount(3);
    await page.locator('.csa-row').nth(0).check();
    await page.locator('.csa-row').nth(1).check();
    await expect(page.locator('#csa-selected')).toHaveText('2 selected');
    await page.selectOption('#csa-to', String(rep.id));
    await page.click('button:has-text("Review")');
    const modal = page.locator('.modal').last();
    await expect(modal.locator('#csa-apply')).toHaveText('Apply 2 Changes');
    expect(await owner(page, rows[0].id)).toBeNull(); // nothing saved by reviewing
    await modal.locator('#csa-apply').click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('#csa-tbody')).toContainText(rep.name);
    const owners = await Promise.all(rows.map(r => owner(page, r.id)));
    expect(owners.filter(o => o === rep.id).length).toBe(2);

    await page.evaluate(() => App.showSection('customers'));
    await page.selectOption('#cust-salesperson-filter', String(rep.id));
    await expect(page.locator('#cust-tbody tr')).toHaveCount(2);
    await expect(page.locator('#cust-tbody')).toContainText(rep.name);
  });

  test('select all matching covers every customer in the filter, not just those shown', async ({ page }) => {
    const rep = await createSalesperson(page, 'All');
    const { rows, last } = await createCustomers(page, 3);
    await openScreen(page, last);
    await page.locator('.csa-row').first().check();
    await page.click('#csa-all');
    await expect(page.locator('#csa-selected')).toHaveText('3 selected');
    await page.selectOption('#csa-to', String(rep.id));
    await page.click('button:has-text("Review")');
    await page.click('#csa-apply');
    await expect(page.locator('.modal')).toHaveCount(0);
    for (const r of rows) expect(await owner(page, r.id)).toBe(rep.id);
  });

  test('existing assignments stay unless Replace is ticked', async ({ page }) => {
    const [first, second] = [await createSalesperson(page, 'First'), await createSalesperson(page, 'Second')];
    const { rows, last } = await createCustomers(page, 2);
    await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: [rows[0].id], salesperson_id: first.id });
    await openScreen(page, last);
    await page.click('#csa-tbody input.csa-row >> nth=0');
    await page.click('#csa-tbody input.csa-row >> nth=1');
    await page.selectOption('#csa-to', String(second.id));
    await page.click('button:has-text("Review")');
    const modal = page.locator('.modal').last();
    await expect(modal.locator('#csa-apply')).toHaveText('Apply 1 Change');
    await expect(modal).toContainText('staying there');
    await modal.locator('#csa-replace').check();
    await expect(page.locator('#csa-apply')).toHaveText('Apply 2 Changes');
    await expect(page.locator('.modal').last()).toContainText(`${first.name} → ${second.name}`);
    await page.locator('#csa-replace').uncheck();
    await expect(page.locator('#csa-apply')).toHaveText('Apply 1 Change');
    await page.click('#csa-apply');
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(await owner(page, rows[0].id)).toBe(first.id);
    expect(await owner(page, rows[1].id)).toBe(second.id);
  });

  test('None removes an assignment', async ({ page }) => {
    const rep = await createSalesperson(page, 'Gone');
    const { rows } = await createCustomers(page, 1);
    await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: [rows[0].id], salesperson_id: rep.id });
    const r = await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: [rows[0].id], salesperson_id: 'none' });
    expect(r.changes).toBe(1);
    expect(await owner(page, rows[0].id)).toBeNull();
  });

  test('a sheet assigns by number or name and explains what it can\'t use', async ({ page }) => {
    const [a, b] = [await createSalesperson(page, 'SheetA'), await createSalesperson(page, 'SheetB')];
    const one = (await createCustomers(page, 4));
    const twin = await createCustomers(page, 2);
    await api(page, 'PUT', `/customers/${twin.rows[1].id}`, { ...twin.rows[1], first_name: twin.rows[0].first_name });
    const [c0, c1, c2, c3] = one.rows;
    const csv = [
      'Customer Number,Customer Name,Salesperson',
      `${c0.customer_number},,${a.name}`,
      `,${c1.first_name} ${c1.last_name},${b.name.toLowerCase()}`,
      `${c2.customer_number},,`,
      `NOPE-1,,${a.name}`,
      `,${twin.rows[0].first_name} ${twin.last},${a.name}`,
      `${c3.customer_number},,Nobody Here`,
    ].join('\n');
    await openScreen(page);
    await upload(page, csv);
    const modal = page.locator('.modal').last();
    await expect(modal).toContainText('No active customer has this number or name');
    await expect(modal).toContainText('2 customers have this name');
    await expect(modal).toContainText("Nobody Here isn't an active Salesperson");
    await expect(modal).toContainText('Salesperson left blank');
    await expect(modal.locator('#csa-apply')).toHaveText('Apply 2 Changes');
    await modal.locator('#csa-apply').click();
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(await owner(page, c0.id)).toBe(a.id);
    expect(await owner(page, c1.id)).toBe(b.id);
    expect(await owner(page, c2.id)).toBeNull();
    expect(await owner(page, c3.id)).toBeNull();
    const batches = await api(page, 'GET', '/customer-salespeople/batches');
    expect(batches[0]).toMatchObject({ source: 'file', file_name: 'assign.csv', change_count: 2 });
  });

  test('a customer given two different salespeople in a sheet is left alone', async ({ page }) => {
    const [a, b] = [await createSalesperson(page, 'ClashA'), await createSalesperson(page, 'ClashB')];
    const { rows: [c] } = await createCustomers(page, 1);
    const p = await api(page, 'POST', '/customer-salespeople/preview', { rows: [
      { line: 2, customer: c.customer_number, salesperson: a.name },
      { line: 3, customer: c.customer_number, salesperson: b.name },
    ] });
    expect(p.changes).toBe(0);
    expect(p.unmatched[0].reason).toContain('neither row was used');
  });

  test('a downloaded sheet can be edited and uploaded again', async ({ page }) => {
    const [a, b] = [await createSalesperson(page, 'RoundA'), await createSalesperson(page, 'RoundB')];
    const { rows, last } = await createCustomers(page, 2);
    await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: rows.map(r => r.id), salesperson_id: a.id });
    const csv = await page.evaluate(q => fetch(`/api/customer-salespeople/export?search=${q}`).then(r => r.text()), last);
    expect(csv.split('\r\n')[0]).toBe('Customer Number,Customer Name,Phone,Salesperson');
    expect(csv).toContain(a.name);
    await openScreen(page);
    const edited = csv.replace(a.name, b.name);
    await upload(page, edited);
    const modal = page.locator('.modal').last();
    await expect(modal).toContainText('Already assigned to that person');
    await modal.locator('#csa-replace').check();
    await expect(page.locator('#csa-apply')).toHaveText('Apply 1 Change');
    await page.click('#csa-apply');
    await expect(page.locator('.modal')).toHaveCount(0);
    const owners = await Promise.all(rows.map(r => owner(page, r.id)));
    expect(owners.sort()).toEqual([a.id, b.id].sort());
  });

  test('Undo puts a batch back, leaving customers changed again since', async ({ page }) => {
    const [a, b, c] = [await createSalesperson(page, 'UndoA'), await createSalesperson(page, 'UndoB'), await createSalesperson(page, 'UndoC')];
    const { rows } = await createCustomers(page, 3);
    await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: [rows[0].id], salesperson_id: a.id });
    const batch = await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: rows.map(r => r.id), salesperson_id: b.id, replace: true });
    await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: [rows[2].id], salesperson_id: c.id, replace: true });

    await openScreen(page);
    await page.click('button:has-text("History")');
    const row = page.locator('.modal tbody tr').filter({ hasText: 'List' }).nth(1);
    await expect(row).toContainText('3');
    page.once('dialog', d => d.accept());
    await row.locator('button:has-text("Undo")').click();
    await expect(page.locator('.modal tbody tr').nth(1)).toContainText('Undone');
    expect(await owner(page, rows[0].id)).toBe(a.id);
    expect(await owner(page, rows[1].id)).toBeNull();
    expect(await owner(page, rows[2].id)).toBe(c.id);
    const again = await attempt(page, 'POST', `/customer-salespeople/batches/${batch.batch_id}/undo`, {});
    expect(again.error).toContain('already been undone');
  });

  test('the customer form\'s change is logged too', async ({ page }) => {
    const rep = await createSalesperson(page, 'Form');
    const { rows: [c] } = await createCustomers(page, 1);
    const full = await api(page, 'GET', `/customers/${c.id}`);
    await api(page, 'PUT', `/customers/${c.id}`, { ...full, salesperson_id: rep.id });
    const batches = await api(page, 'GET', '/customer-salespeople/batches');
    expect(batches[0]).toMatchObject({ source: 'form', change_count: 1 });
    const detail = await api(page, 'GET', `/customer-salespeople/batches/${batches[0].id}`);
    expect(detail[0].new_name).toBe(rep.name);
  });

  test('a stale review is refused, and bad requests explain themselves', async ({ page }) => {
    const rep = await createSalesperson(page, 'Stale');
    const { rows } = await createCustomers(page, 2);
    const stale = await attempt(page, 'POST', '/customer-salespeople/apply', { customer_ids: rows.map(r => r.id), salesperson_id: rep.id, expected_changes: 1 });
    expect(stale.error).toContain('Review it again');
    expect(await owner(page, rows[0].id)).toBeNull();
    expect((await attempt(page, 'POST', '/customer-salespeople/preview', { customer_ids: [rows[0].id], salesperson_id: 999999 })).error).toContain('active Salesperson');
    expect((await attempt(page, 'POST', '/customer-salespeople/preview', { salesperson_id: rep.id })).error).toContain('at least one customer');
  });

  test('assigned customers\' sales go to their salesperson', async ({ page }) => {
    const rep = await createSalesperson(page, 'Sale');
    const { rows: [c] } = await createCustomers(page, 1);
    await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: [c.id], salesperson_id: rep.id });
    const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.has_variations && p.stock_qty > 5 && p.price > 0)));
    const held = await api(page, 'POST', '/transactions/hold', { customer_id: c.id, employee_id: 1, created_by: 1, branch_id: 1, items: [{ product_id: product.id, product_name: product.name, quantity: 1, unit_price: product.price, tax_rate: product.tax_rate }] });
    expect(held.salesperson_id).toBe(rep.id);
  });

  test('a salesperson sees My Customers read-only, and can\'t use the bulk tool', async ({ page, browser }) => {
    const rep = await createSalesperson(page, 'Mine');
    const { rows } = await createCustomers(page, 2);
    await api(page, 'POST', '/customer-salespeople/apply', { customer_ids: [rows[0].id], salesperson_id: rep.id });

    const context = await browser.newContext();
    const theirs = await context.newPage();
    await theirs.goto('/');
    await theirs.fill('#login-user', rep.username);
    await theirs.fill('#login-pass', 'pw-123456');
    await theirs.click('button.login-btn');
    await theirs.waitForFunction(() => App.currentUser);
    expect(await theirs.evaluate(() => App.can('sales_manager'))).toBe(false);
    await theirs.evaluate(() => App.showSection('customers'));
    await expect(theirs.locator('#cust-salesperson-filter option[value="me"]')).toHaveCount(1);
    await theirs.selectOption('#cust-salesperson-filter', 'me');
    await expect(theirs.locator('#cust-tbody tr')).toHaveCount(1);
    await expect(theirs.locator('#cust-tbody')).toContainText(rows[0].customer_number);
    await expect(theirs.locator('button', { hasText: 'Assign Salespeople' })).toHaveCount(0);

    await theirs.evaluate(id => App.showCustomerForm(id), rows[0].id);
    await expect(theirs.locator('#cf-salesperson')).toBeDisabled();
    await expect(theirs.locator('#cf-salesperson')).toHaveValue(String(rep.id));

    for (const [m, u, d] of [['POST', '/customer-salespeople/preview', { customer_ids: [rows[1].id], salesperson_id: rep.id }], ['POST', '/customer-salespeople/apply', { customer_ids: [rows[1].id], salesperson_id: rep.id }], ['GET', '/customer-salespeople/export']]) {
      const r = await theirs.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'allowed', e => e.message), [m, u, d]);
      expect(r).toContain('sales_manager');
    }
    expect(await owner(page, rows[1].id)).toBeNull();
    await context.close();
  });
});
