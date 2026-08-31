const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');

// Sales summary for a date range
router.get('/sales', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({ sql: `SELECT COUNT(*) as transaction_count, SUM(total) as gross_sales, SUM(tax_amount) as total_tax, SUM(discount_amount) as total_discounts, AVG(total) as avg_order FROM transactions WHERE status='completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf}`, args: [s, e, ...bp] });
    const { rows: byDay } = await db.execute({ sql: `SELECT date(created_at) as date, COUNT(*) as transactions, SUM(total) as sales FROM transactions WHERE status='completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY date(created_at) ORDER BY date`, args: [s, e, ...bp] });
    // Sums per-leg amounts from transaction_payments (so a split-tender
    // sale's cash portion and card portion land in separate buckets),
    // falling back to the whole transaction total for any transaction with
    // no transaction_payments rows.
    const bfAliased = branch_id ? ' AND t.branch_id = ?' : '';
    const { rows: byMethod } = await db.execute({ sql: `
      SELECT payment_method, COUNT(DISTINCT transaction_id) as count, SUM(amount) as total
      FROM (
        SELECT tp.transaction_id, tp.payment_method, tp.amount
        FROM transaction_payments tp JOIN transactions t ON t.id = tp.transaction_id
        WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bfAliased}
        UNION ALL
        SELECT t.id as transaction_id, t.payment_method, t.total as amount
        FROM transactions t
        WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bfAliased} AND NOT EXISTS (SELECT 1 FROM transaction_payments tp2 WHERE tp2.transaction_id = t.id)
      )
      GROUP BY payment_method`, args: [s, e, ...bp, s, e, ...bp] });

    res.json({ summary, byDay, byMethod });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Top selling products
router.get('/top-products', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, limit = 10, branch_id, category_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];
    // Filtering by category requires joining products — this also has the side
    // effect of excluding non-product line items (deposits, fees) that carry
    // no product_id, which is desirable for a "top selling products" report.
    const cf = category_id ? ' AND p.category_id = ?' : '';
    const cp = category_id ? [category_id] : [];

    const { rows: products } = await db.execute({ sql: `SELECT ti.product_name, ti.sku, SUM(ti.quantity) as units_sold, SUM(ti.total) as revenue, COUNT(DISTINCT ti.transaction_id) as transactions FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id JOIN products p ON ti.product_id = p.id WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}${cf} GROUP BY ti.product_id ORDER BY units_sold DESC LIMIT ?`, args: [s, e, ...bp, ...cp, parseInt(limit)] });
    res.json(products);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sales by category
router.get('/by-category', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: data } = await db.execute({ sql: `SELECT c.name as category, SUM(ti.quantity) as units_sold, SUM(ti.total) as revenue FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id JOIN products p ON ti.product_id = p.id JOIN categories c ON p.category_id = c.id WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY c.id ORDER BY revenue DESC`, args: [s, e, ...bp] });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Inventory value report
router.get('/inventory', requirePermission('reports'), async (req, res) => {
  try {
    const { branch_id, category_id } = req.query;
    const bf = branch_id ? ' AND bi.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];
    const catFilterP = category_id ? ' AND p.category_id = ?' : '';
    const catFilterNoAlias = category_id ? ' AND category_id = ?' : '';
    const catP = category_id ? [category_id] : [];

    // When a branch is given, totals come from that branch's branch_inventory
    // rows instead of the global products.stock_qty column, same scoping the
    // low-stock list below already uses — otherwise the branch filter would
    // visibly do nothing to these stat cards.
    let summary;
    if (branch_id) {
      const { rows: [row] } = await db.execute({ sql: `SELECT COUNT(DISTINCT p.id) as total_products, SUM(bi.stock_qty) as total_units, SUM(bi.stock_qty * p.cost) as cost_value, SUM(bi.stock_qty * MAX(0, ROUND(p.price * (1 + COALESCE(b.price_tier_percent,0)/100.0), 2))) as retail_value FROM branch_inventory bi JOIN products p ON bi.product_id = p.id JOIN branches b ON bi.branch_id = b.id WHERE p.active = 1 AND bi.branch_id = ?${catFilterP}`, args: [branch_id, ...catP] });
      summary = row;
    } else {
      const { rows: [row] } = await db.execute({ sql: `SELECT COUNT(*) as total_products, SUM(stock_qty) as total_units, SUM(stock_qty * cost) as cost_value, SUM(stock_qty * price) as retail_value FROM products WHERE active = 1${catFilterNoAlias}`, args: [...catP] });
      summary = row;
    }
    // Products with no branch_inventory row at all (never touched by a
    // branch-scoped PO/transfer/sale) fall back to the global products.stock_qty
    // check below — otherwise they'd never appear here even if genuinely low,
    // which is exactly the drift that made this list disagree with the header
    // low-stock count (that one always reads products.stock_qty).
    const globalFallbackSql = !branch_id ? `
      UNION ALL
      SELECT p.sku, p.name, c.name as category_name, NULL as branch_name, p.stock_qty, p.min_stock
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.active=1 AND p.is_rental=0 AND p.is_service=0 AND p.stock_qty <= p.min_stock
        AND NOT EXISTS (SELECT 1 FROM branch_inventory bi2 JOIN branches b2 ON bi2.branch_id = b2.id WHERE bi2.product_id = p.id AND b2.active = 1)
        ${catFilterP}` : '';
    const { rows: lowStock } = await db.execute({ sql: `SELECT sku, name, category_name, branch_name, stock_qty, min_stock FROM (
      SELECT p.sku, p.name, c.name as category_name, b.name as branch_name, bi.stock_qty, bi.min_stock
      FROM branch_inventory bi JOIN products p ON bi.product_id = p.id JOIN branches b ON bi.branch_id = b.id LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.active=1 AND p.is_rental=0 AND p.is_service=0 AND b.active=1 AND bi.stock_qty <= bi.min_stock${bf}${catFilterP}
      ${globalFallbackSql}
    ) ORDER BY stock_qty ASC`, args: [...bp, ...catP, ...(branch_id ? [] : catP)] });
    const { rows: byCategory } = await db.execute({ sql: `SELECT c.name as category, COUNT(p.id) as products, SUM(p.stock_qty) as units, SUM(p.stock_qty * p.cost) as cost_value FROM products p JOIN categories c ON p.category_id = c.id WHERE p.active=1 GROUP BY c.id`, args: [] });
    // Warehouses carry no sales, so they're excluded from the sales-report branch
    // filter above — but their stock still has real value, tracked separately here.
    const { rows: warehouseValue } = await db.execute({ sql: `SELECT b.id as branch_id, b.name as branch_name, COUNT(DISTINCT bi.product_id) as total_products, SUM(bi.stock_qty) as total_units, SUM(bi.stock_qty * p.cost) as cost_value, SUM(bi.stock_qty * MAX(0, ROUND(p.price * (1 + COALESCE(b.price_tier_percent,0)/100.0), 2))) as retail_value FROM branch_inventory bi JOIN branches b ON bi.branch_id = b.id JOIN products p ON bi.product_id = p.id WHERE b.is_warehouse = 1 AND p.active = 1 GROUP BY b.id ORDER BY b.name`, args: [] });
    res.json({ summary, lowStock, byCategory, warehouseValue });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// requireAuth only — Dashboard is the universal post-login landing page for
// every role, not gated by the reports permission.
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const { branch_id } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];
    const warehouseExclude = `AND t.branch_id NOT IN (SELECT id FROM branches WHERE is_warehouse = 1)`;
    // A salesperson's dashboard shows only their own sales, not the store's —
    // see is_salesperson migration note in database.js.
    const mine = !!req.employee?.is_salesperson;
    const ef = mine ? ' AND t.employee_id = ?' : '';
    const ep = mine ? [req.employee.id] : [];

    const { rows: [todayStats] } = await db.execute({ sql: `SELECT COUNT(*) as transactions, COALESCE(SUM(total),0) as sales FROM transactions t WHERE t.status='completed' AND date(t.created_at) = date(?) ${warehouseExclude}${bf}${ef}`, args: [today, ...bp, ...ep] });
    const { rows: [monthStats] } = await db.execute({ sql: `SELECT COUNT(*) as transactions, COALESCE(SUM(total),0) as sales FROM transactions t WHERE t.status='completed' AND date(t.created_at) >= date(?) ${warehouseExclude}${bf}${ef}`, args: [monthStart, ...bp, ...ep] });
    const { rows: [totalCustomers] } = await db.execute({ sql: 'SELECT COUNT(*) as count FROM customers WHERE active=1', args: [] });
    // Mirrors the /inventory report's low-stock logic (branch_inventory rows,
    // falling back to products.stock_qty only for products with no branch
    // record) — this used to just check products.stock_qty on its own, which
    // made the header badge disagree with the warehouse report's count.
    const { rows: [lowStock] } = await db.execute({ sql: `SELECT COUNT(*) as count FROM (
        SELECT DISTINCT p.id FROM branch_inventory bi JOIN products p ON bi.product_id = p.id JOIN branches b ON bi.branch_id = b.id
        WHERE p.active=1 AND p.is_rental=0 AND p.is_service=0 AND b.active=1 AND bi.stock_qty <= bi.min_stock
        UNION
        SELECT p.id FROM products p
        WHERE p.active=1 AND p.is_rental=0 AND p.is_service=0 AND p.stock_qty <= p.min_stock
          AND NOT EXISTS (SELECT 1 FROM branch_inventory bi2 JOIN branches b2 ON bi2.branch_id = b2.id WHERE bi2.product_id = p.id AND b2.active = 1)
      )`, args: [] });
    const { rows: recentTx } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id WHERE t.branch_id NOT IN (SELECT id FROM branches WHERE is_warehouse = 1)${bf}${ef} ORDER BY t.created_at DESC LIMIT 5`, args: [...bp, ...ep] });
    const { rows: last7Days } = await db.execute({ sql: `SELECT date(t.created_at) as date, COALESCE(SUM(t.total),0) as sales, COUNT(*) as transactions FROM transactions t WHERE t.status='completed' AND date(t.created_at) >= date('now', '-6 days') ${warehouseExclude}${bf}${ef} GROUP BY date(t.created_at) ORDER BY date`, args: [...bp, ...ep] });

    // Cross-branch/company performance has no place on a salesperson's
    // personal view — only computed for everyone else.
    const byLocation = mine ? [] : (await db.execute({ sql: `SELECT b.id, b.name, b.city, b.state,
        COALESCE(SUM(CASE WHEN date(t.created_at) = date(?) THEN t.total ELSE 0 END), 0) as today_sales,
        COUNT(CASE WHEN date(t.created_at) = date(?) THEN 1 END) as today_transactions,
        COALESCE(SUM(CASE WHEN date(t.created_at) >= date(?) THEN t.total ELSE 0 END), 0) as month_sales,
        COUNT(CASE WHEN date(t.created_at) >= date(?) THEN 1 END) as month_transactions
      FROM branches b
      LEFT JOIN transactions t ON t.branch_id = b.id AND t.status = 'completed'
      WHERE b.active = 1 AND b.is_warehouse = 0
      GROUP BY b.id
      ORDER BY b.name`, args: [today, today, monthStart, monthStart] })).rows;

    res.json({ todayStats, monthStats, totalCustomers, lowStock, recentTx, last7Days, byLocation });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AR Collections report
router.get('/ar-collections', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND p.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({ sql: `SELECT COUNT(*) as payment_count, COALESCE(SUM(amount), 0) as total_collected FROM account_payments p WHERE date(p.created_at) BETWEEN date(?) AND date(?)${bf}`, args: [s, e, ...bp] });
    const { rows: byDay } = await db.execute({ sql: `SELECT date(p.created_at) as date, COUNT(*) as payments, COALESCE(SUM(p.amount), 0) as collected FROM account_payments p WHERE date(p.created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY date(p.created_at) ORDER BY date`, args: [s, e, ...bp] });
    const { rows: byMethod } = await db.execute({ sql: `SELECT p.payment_method, COUNT(*) as count, COALESCE(SUM(p.amount), 0) as total FROM account_payments p WHERE date(p.created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY p.payment_method ORDER BY total DESC`, args: [s, e, ...bp] });
    const { rows: byCustomer } = await db.execute({ sql: `SELECT c.customer_number, c.first_name || ' ' || c.last_name as customer_name, COUNT(*) as payments, COALESCE(SUM(p.amount), 0) as total_paid, c.account_balance as outstanding FROM account_payments p JOIN customers c ON p.customer_id = c.id WHERE date(p.created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY p.customer_id ORDER BY total_paid DESC`, args: [s, e, ...bp] });

    res.json({ summary, byDay, byMethod, byCustomer });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Promotions report
router.get('/promotions', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: byPromotion } = await db.execute({ sql: `SELECT promotion_name, promotion_code, COUNT(*) as times_used, SUM(discount_amount) as total_discount, SUM(total) as total_sales FROM transactions WHERE status='completed' AND promotion_code IS NOT NULL AND date(created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY promotion_code ORDER BY total_discount DESC`, args: [s, e, ...bp] });
    const { rows: [totals] } = await db.execute({ sql: `SELECT COUNT(*) as promo_transactions, COALESCE(SUM(discount_amount),0) as total_discount, COALESCE(SUM(total),0) as total_sales FROM transactions WHERE status='completed' AND promotion_code IS NOT NULL AND date(created_at) BETWEEN date(?) AND date(?)${bf}`, args: [s, e, ...bp] });

    res.json({ totals, byPromotion });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
