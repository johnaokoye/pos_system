const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../database');

// ── WC API helpers ───────────────────────────────────────────────────────────

async function getWcSettings() {
  const keys = ['woo_url', 'woo_consumer_key', 'woo_consumer_secret', 'woo_pos_url'];
  const { rows } = await db.execute({
    sql: `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`,
    args: keys,
  });
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  if (!s.woo_url || !s.woo_consumer_key || !s.woo_consumer_secret) {
    throw new Error('WooCommerce not configured. Set URL, Consumer Key, and Consumer Secret in Settings.');
  }
  s.woo_url = s.woo_url.replace(/\/$/, '');
  if (s.woo_pos_url) s.woo_pos_url = s.woo_pos_url.replace(/\/$/, '');
  return s;
}

// RFC 3986 percent-encoding (stricter than encodeURIComponent)
function pct(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/\*/g, '%2A')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// Build an OAuth 1.0a signed URL (required for HTTP stores)
function oauthSign(s, method, baseUrl, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key:    s.woo_consumer_key,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:       Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:           crypto.randomBytes(16).toString('hex'),
    oauth_version:         '1.0',
    ...extraParams,
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map(k => `${pct(k)}=${pct(oauthParams[k])}`)
    .join('&');

  const base = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(paramString)}`;
  const key  = `${pct(s.woo_consumer_secret)}&`; // token_secret empty for one-legged OAuth
  oauthParams.oauth_signature = crypto.createHmac('sha256', key).update(base).digest('base64');
  return oauthParams;
}

async function wcRequest(s, method, path, body = null, params = {}) {
  const baseUrl = `${s.woo_url}/wp-json/wc/v3${path}`;
  const isHttps = s.woo_url.startsWith('https://');
  const url = new URL(baseUrl);

  if (isHttps) {
    // HTTPS: simple query-param auth
    url.searchParams.set('consumer_key', s.woo_consumer_key);
    url.searchParams.set('consumer_secret', s.woo_consumer_secret);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  } else {
    // HTTP: OAuth 1.0a required
    const signed = oauthSign(s, method, baseUrl, params);
    Object.entries(signed).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url.toString(), opts);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    if (res.status === 404) throw new Error(`Endpoint not found (404). Verify the Store URL is correct and WordPress permalinks are not set to Plain.`);
    if (res.redirected || text.trimStart().startsWith('<')) throw new Error(`Received HTML instead of JSON (status ${res.status}). The store URL may be redirecting (e.g. HTTP→HTTPS or www redirect). Try adjusting the URL to match exactly.`);
    throw new Error(`Unexpected response (${res.status}): ${text.slice(0, 120)}`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `WC API ${res.status}`);
  return { data, totalPages: parseInt(res.headers.get('X-WP-TotalPages') || '1') };
}

async function wcGetAll(s, path, params = {}) {
  const results = [];
  let page = 1;
  while (true) {
    const { data, totalPages } = await wcRequest(s, 'GET', path, null, { ...params, per_page: 100, page });
    results.push(...data);
    if (page >= totalPages) break;
    page++;
  }
  return results;
}

// ── Sync log helpers ─────────────────────────────────────────────────────────

async function createLog(syncType) {
  const r = await db.execute({
    sql: 'INSERT INTO woo_sync_log (sync_type, status) VALUES (?, ?)',
    args: [syncType, 'running'],
  });
  return Number(r.lastInsertRowid);
}

async function updateLog(id, updates) {
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await db.execute({
    sql: `UPDATE woo_sync_log SET ${sets} WHERE id = ?`,
    args: [...Object.values(updates), id],
  });
}

async function saveSetting(key, value) {
  await db.execute({
    sql: 'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    args: [key, value],
  });
}

async function upsertMap(entityType, localId, wooId) {
  await db.execute({
    sql: `INSERT INTO woo_sync_map (entity_type, local_id, woo_id) VALUES (?,?,?)
          ON CONFLICT(entity_type, local_id) DO UPDATE SET woo_id=excluded.woo_id, last_synced_at=CURRENT_TIMESTAMP`,
    args: [entityType, localId, wooId],
  });
}

// ── Category sync (prerequisite for products) ────────────────────────────────

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'");
}

function normalise(str) {
  return decodeHtmlEntities(str).toLowerCase().trim();
}

function buildCatNameMap(wcCats) {
  const m = {};
  wcCats.forEach(c => { m[normalise(c.name)] = c.id; });
  return m;
}

async function ensureWcCategories(s) {
  const { rows: posCategories } = await db.execute({ sql: 'SELECT id, name FROM categories', args: [] });

  // Skip categories we already mapped
  const { rows: mapped } = await db.execute({
    sql: "SELECT local_id, woo_id FROM woo_sync_map WHERE entity_type = 'category'",
    args: [],
  });
  const alreadyMapped = {};
  mapped.forEach(r => { alreadyMapped[r.local_id] = r.woo_id; });

  let wcCatByName = buildCatNameMap(await wcGetAll(s, '/products/categories'));

  const idMap = {};
  for (const cat of posCategories) {
    if (alreadyMapped[cat.id]) {
      idMap[cat.id] = alreadyMapped[cat.id];
      continue;
    }

    let wcId = wcCatByName[normalise(cat.name)];

    if (!wcId) {
      try {
        const { data: created } = await wcRequest(s, 'POST', '/products/categories', { name: cat.name });
        wcId = created.id;
      } catch (e) {
        if (e.message.includes('already exists')) {
          // Re-fetch the full list fresh — WC may not have returned it in the initial page
          wcCatByName = buildCatNameMap(await wcGetAll(s, '/products/categories'));
          wcId = wcCatByName[normalise(cat.name)];
          if (!wcId) throw new Error(`Category "${cat.name}" already exists in WooCommerce but could not be matched. Rename it in WooCommerce to match exactly, then sync again.`);
        } else {
          throw e;
        }
      }
    }

    if (wcId) {
      idMap[cat.id] = wcId;
      await upsertMap('category', cat.id, wcId);
    }
  }
  return idMap;
}

// ── Products: POS → WooCommerce ──────────────────────────────────────────────

async function syncProducts() {
  const logId = await createLog('products');
  const counts = { processed: 0, created: 0, updated: 0, failed: 0, errors: [] };

  try {
    const s = await getWcSettings();
    const catMap = await ensureWcCategories(s);

    const { rows: products } = await db.execute({
      sql: 'SELECT p.* FROM products p WHERE p.active = 1',
      args: [],
    });

    const { rows: mapped } = await db.execute({
      sql: "SELECT local_id, woo_id FROM woo_sync_map WHERE entity_type = 'product'",
      args: [],
    });
    const syncMap = {};
    mapped.forEach(r => { syncMap[r.local_id] = r.woo_id; });

    for (const p of products) {
      counts.processed++;
      const wcProduct = {
        name: p.name,
        type: 'simple',
        sku: p.sku,
        regular_price: String(p.price),
        description: p.description || '',
        manage_stock: true,
        stock_quantity: p.stock_qty,
        status: 'publish',
        tax_status: p.tax_rate > 0 ? 'taxable' : 'none',
        ...(p.category_id && catMap[p.category_id]
          ? { categories: [{ id: catMap[p.category_id] }] }
          : {}),
        ...(p.image_path && s.woo_pos_url
          ? { images: [{ src: `${s.woo_pos_url}${p.image_path}` }] }
          : {}),
      };

      try {
        if (syncMap[p.id]) {
          await wcRequest(s, 'PUT', `/products/${syncMap[p.id]}`, wcProduct);
          counts.updated++;
        } else {
          const existing = await wcGetAll(s, '/products', { sku: p.sku });
          if (existing.length > 0) {
            await wcRequest(s, 'PUT', `/products/${existing[0].id}`, wcProduct);
            await upsertMap('product', p.id, existing[0].id);
            counts.updated++;
          } else {
            const { data: created } = await wcRequest(s, 'POST', '/products', wcProduct);
            await upsertMap('product', p.id, created.id);
            counts.created++;
          }
        }
      } catch (e) {
        counts.failed++;
        counts.errors.push(`${p.sku}: ${e.message}`);
      }
    }

    await updateLog(logId, {
      status: 'completed',
      records_processed: counts.processed,
      records_created: counts.created,
      records_updated: counts.updated,
      records_failed: counts.failed,
      error_details: counts.errors.length ? JSON.stringify(counts.errors) : null,
      completed_at: new Date().toISOString(),
    });
    await saveSetting('woo_last_sync_products', new Date().toISOString());
    return counts;
  } catch (e) {
    await updateLog(logId, { status: 'failed', error_details: e.message, completed_at: new Date().toISOString() });
    throw e;
  }
}

// ── Customers: POS → WooCommerce ─────────────────────────────────────────────

async function syncCustomers() {
  const logId = await createLog('customers');
  const counts = { processed: 0, created: 0, updated: 0, failed: 0, errors: [] };

  try {
    const s = await getWcSettings();

    const { rows: customers } = await db.execute({
      sql: "SELECT * FROM customers WHERE active = 1 AND email IS NOT NULL AND email != ''",
      args: [],
    });

    const { rows: mapped } = await db.execute({
      sql: "SELECT local_id, woo_id FROM woo_sync_map WHERE entity_type = 'customer'",
      args: [],
    });
    const syncMap = {};
    mapped.forEach(r => { syncMap[r.local_id] = r.woo_id; });

    for (const c of customers) {
      counts.processed++;
      const wcCustomer = {
        email: c.email,
        first_name: c.first_name,
        last_name: c.last_name,
        billing: {
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          phone: c.phone || '',
          address_1: c.address || '',
          city: c.city || '',
          state: c.state || '',
          postcode: c.zip || '',
        },
      };

      try {
        if (syncMap[c.id]) {
          await wcRequest(s, 'PUT', `/customers/${syncMap[c.id]}`, wcCustomer);
          counts.updated++;
        } else {
          const existing = await wcGetAll(s, '/customers', { email: c.email });
          if (existing.length > 0) {
            await wcRequest(s, 'PUT', `/customers/${existing[0].id}`, wcCustomer);
            await upsertMap('customer', c.id, existing[0].id);
            counts.updated++;
          } else {
            const { data: created } = await wcRequest(s, 'POST', '/customers', wcCustomer);
            await upsertMap('customer', c.id, created.id);
            counts.created++;
          }
        }
      } catch (e) {
        counts.failed++;
        counts.errors.push(`${c.email}: ${e.message}`);
      }
    }

    await updateLog(logId, {
      status: 'completed',
      records_processed: counts.processed,
      records_created: counts.created,
      records_updated: counts.updated,
      records_failed: counts.failed,
      error_details: counts.errors.length ? JSON.stringify(counts.errors) : null,
      completed_at: new Date().toISOString(),
    });
    await saveSetting('woo_last_sync_customers', new Date().toISOString());
    return counts;
  } catch (e) {
    await updateLog(logId, { status: 'failed', error_details: e.message, completed_at: new Date().toISOString() });
    throw e;
  }
}

// ── Orders: WooCommerce → POS transactions ───────────────────────────────────

async function syncOrders() {
  const logId = await createLog('orders');
  const counts = { processed: 0, created: 0, updated: 0, failed: 0, errors: [] };

  try {
    const s = await getWcSettings();

    const { rows: [lastRow] } = await db.execute({
      sql: "SELECT value FROM settings WHERE key = 'woo_last_sync_orders'",
      args: [],
    });
    const params = { status: 'completed,processing' };
    if (lastRow?.value) params.after = lastRow.value;

    const orders = await wcGetAll(s, '/orders', params);

    const { rows: mapped } = await db.execute({
      sql: "SELECT woo_id FROM woo_sync_map WHERE entity_type = 'order'",
      args: [],
    });
    const importedWooIds = new Set(mapped.map(r => r.woo_id));

    for (const order of orders) {
      if (importedWooIds.has(order.id)) continue;
      counts.processed++;

      try {
        let customerId = null;
        if (order.billing?.email) {
          const { rows: [cust] } = await db.execute({
            sql: 'SELECT id FROM customers WHERE email = ?',
            args: [order.billing.email],
          });
          customerId = cust?.id || null;
        }

        const txNum = `WC-${String(order.id).padStart(6, '0')}`;
        const subtotal = parseFloat(order.subtotal || 0);
        const taxAmount = parseFloat(order.total_tax || 0);
        const discountAmount = parseFloat(order.discount_total || 0);
        const total = parseFloat(order.total || 0);
        const paymentMethod = order.payment_method === 'cod' ? 'cash' : 'card';
        const createdAt = order.date_created || new Date().toISOString();

        const txResult = await db.execute({
          sql: `INSERT OR IGNORE INTO transactions
                  (transaction_number, customer_id, employee_id, subtotal, tax_amount,
                   discount_amount, total, payment_method, amount_tendered, change_amount,
                   status, notes, created_at)
                VALUES (?,?,1,?,?,?,?,?,?,0,?,?,?)`,
          args: [txNum, customerId, subtotal, taxAmount, discountAmount, total,
                 paymentMethod, total, 'completed',
                 `WooCommerce Order #${order.number}`, createdAt],
        });

        if (Number(txResult.rowsAffected) > 0) {
          const txId = Number(txResult.lastInsertRowid);

          for (const item of order.line_items || []) {
            const { rows: [prod] } = await db.execute({
              sql: 'SELECT id FROM products WHERE sku = ?',
              args: [item.sku || ''],
            });
            await db.execute({
              sql: `INSERT INTO transaction_items
                      (transaction_id, product_id, product_name, sku, quantity,
                       unit_price, discount_amount, tax_amount, total)
                    VALUES (?,?,?,?,?,?,?,?,?)`,
              args: [txId, prod?.id || null, item.name, item.sku || '',
                     item.quantity, parseFloat(item.price),
                     0, parseFloat(item.total_tax || 0), parseFloat(item.total)],
            });
          }

          await upsertMap('order', txId, order.id);
          counts.created++;
        }
      } catch (e) {
        counts.failed++;
        counts.errors.push(`Order #${order.id}: ${e.message}`);
      }
    }

    await updateLog(logId, {
      status: 'completed',
      records_processed: counts.processed,
      records_created: counts.created,
      records_updated: counts.updated,
      records_failed: counts.failed,
      error_details: counts.errors.length ? JSON.stringify(counts.errors) : null,
      completed_at: new Date().toISOString(),
    });
    await saveSetting('woo_last_sync_orders', new Date().toISOString());
    return counts;
  } catch (e) {
    await updateLog(logId, { status: 'failed', error_details: e.message, completed_at: new Date().toISOString() });
    throw e;
  }
}

// ── Run all three ─────────────────────────────────────────────────────────────

async function runSyncAll() {
  const results = {};
  try { results.products = await syncProducts(); } catch (e) { results.products = { error: e.message }; }
  try { results.customers = await syncCustomers(); } catch (e) { results.customers = { error: e.message }; }
  try { results.orders = await syncOrders(); } catch (e) { results.orders = { error: e.message }; }
  await saveSetting('woo_last_auto_sync', new Date().toISOString());
  return results;
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get('/config', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM settings WHERE key LIKE 'woo_%'",
      args: [],
    });
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    res.json(config);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/test', async (req, res) => {
  try {
    const s = await getWcSettings();
    await wcRequest(s, 'GET', '/products', null, { per_page: 1 });
    res.json({ success: true });
  } catch (e) {
    const msg = e.message.includes('cannot list resources')
      ? 'Authentication failed. Check that your API key has Read or Read/Write permission and that WordPress permalinks are not set to Plain (Settings → Permalinks).'
      : e.message;
    res.status(400).json({ error: msg });
  }
});

router.post('/sync/products', async (req, res) => {
  try {
    const result = await syncProducts();
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync/customers', async (req, res) => {
  try {
    const result = await syncCustomers();
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync/orders', async (req, res) => {
  try {
    const result = await syncOrders();
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync/all', async (req, res) => {
  try {
    const result = await runSyncAll();
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/logs', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: 'SELECT * FROM woo_sync_log ORDER BY started_at DESC LIMIT 20',
      args: [],
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, runSyncAll };
