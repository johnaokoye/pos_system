import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function post(url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Some endpoints now require a session (see lib/permissions.js's per-route
// rollout) — raw fetch() doesn't carry cookies across calls the way a
// browser page does, so tests that need auth grab the Set-Cookie header
// from a real login and forward it explicitly.
async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  return setCookie.split(';')[0]; // "pos_session=<token>"
}

test.describe('API', () => {
  test('POST /api/employees/login — valid credentials', async () => {
    const { status, body } = await post('/api/employees/login', { username: 'admin', password: '123456' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ username: 'admin', security_group_name: 'Administrator' });
  });

  test('POST /api/employees/login — invalid credentials return 401', async () => {
    const { status } = await post('/api/employees/login', { username: 'admin', password: 'wrong' });
    expect(status).toBe(401);
  });

  test('GET /api/products — requires a session, then returns array of products', async () => {
    const unauth = await fetch(`${BASE}/api/products`);
    expect(unauth.status).toBe(401);

    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/products`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('id');
    expect(body[0]).toHaveProperty('name');
    expect(body[0]).toHaveProperty('price');
  });

  test('GET /api/customers — requires a session, then returns array', async () => {
    const unauth = await fetch(`${BASE}/api/customers`);
    expect(unauth.status).toBe(401);

    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/customers`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/suppliers — requires a session, then returns array', async () => {
    const unauth = await fetch(`${BASE}/api/suppliers`);
    expect(unauth.status).toBe(401);

    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/suppliers`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/categories — requires a session, then returns array', async () => {
    const unauth = await fetch(`${BASE}/api/categories`);
    expect(unauth.status).toBe(401);

    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/categories`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test('GET /api/transactions — requires a session, then returns array', async () => {
    const unauth = await fetch(`${BASE}/api/transactions`);
    expect(unauth.status).toBe(401);

    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/transactions`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/reports/dashboard — requires a session, then returns stats object', async () => {
    const unauth = await fetch(`${BASE}/api/reports/dashboard`);
    expect(unauth.status).toBe(401);

    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/reports/dashboard`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('todayStats');
    expect(body).toHaveProperty('monthStats');
    expect(body).toHaveProperty('totalCustomers');
    expect(body).toHaveProperty('lowStock');
  });

  test('GET /api/employees — requires a session, then returns array', async () => {
    const unauth = await fetch(`${BASE}/api/employees`);
    expect(unauth.status).toBe(401);

    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/employees`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Passwords must not be exposed
    expect(body[0]).not.toHaveProperty('password');
  });
});
