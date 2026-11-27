import { request } from '@playwright/test';

// Consignment orders wait for approval (with signature) by someone other than
// whoever raised them. Tests that just need a receivable order sign it off
// here, in a separate session, so the page stays logged in as it was.
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const USER = 'cons_order_approver';

async function session(origin, username, password) {
  const ctx = await request.newContext({ baseURL: origin });
  const r = await ctx.post('/api/employees/login', { data: { username, password } });
  if (!r.ok()) { await ctx.dispose(); return null; }
  return ctx;
}

export async function approveConsOrder(page, order) {
  const origin = new URL(page.url()).origin;
  let ctx = await session(origin, USER, 'pw-123456');
  if (!ctx) {
    const admin = await session(origin, 'admin', '123456');
    const groups = await (await admin.get('/api/security-groups')).json();
    await admin.post('/api/employees', { data: { first_name: 'Consignment', last_name: 'Order Approver', username: USER, pin: '917351', password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 } });
    await admin.dispose();
    ctx = await session(origin, USER, 'pw-123456');
  }
  const r = await ctx.post(`/api/consignment/orders/${order.id}/approve`, { data: { signature: SIG } });
  const body = await r.json();
  await ctx.dispose();
  if (!r.ok()) throw new Error(`Approving ${order.order_number}: ${body.error}`);
  return body;
}
