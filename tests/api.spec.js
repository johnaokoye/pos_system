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

  test('GET /api/products — returns array of products', async () => {
    const r = await fetch(`${BASE}/api/products`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('id');
    expect(body[0]).toHaveProperty('name');
    expect(body[0]).toHaveProperty('price');
  });

  test('GET /api/customers — returns array', async () => {
    const r = await fetch(`${BASE}/api/customers`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/suppliers — returns array', async () => {
    const r = await fetch(`${BASE}/api/suppliers`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/categories — returns array', async () => {
    const r = await fetch(`${BASE}/api/categories`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test('GET /api/transactions — returns array', async () => {
    const r = await fetch(`${BASE}/api/transactions`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/reports/dashboard — returns stats object', async () => {
    const r = await fetch(`${BASE}/api/reports/dashboard`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('todayStats');
    expect(body).toHaveProperty('monthStats');
    expect(body).toHaveProperty('totalCustomers');
    expect(body).toHaveProperty('lowStock');
  });

  test('GET /api/employees — returns array', async () => {
    const r = await fetch(`${BASE}/api/employees`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Passwords must not be exposed
    expect(body[0]).not.toHaveProperty('password');
  });
});
