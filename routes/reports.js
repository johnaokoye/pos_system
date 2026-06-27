const express = require('express');
const router = express.Router();
const { db } = require('../database');

// Sales summary for a date range
router.get('/sales', async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({ sql: `SELECT COUNT(*) as transaction_count, SUM(total) as gross_sales, SUM(tax_amount) as total_tax, SUM(discount_amount) as total_discounts, AVG(total) as avg_order FROM transactions WHERE status='completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf}`, args: [s, e, ...bp] });
    const { rows: byDay } = await db.execute({ sql: `SELECT date(created_at) as date, COUNT(*) as transactions, SUM(total) as sales FROM transactions WHERE status='completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY date(created_at) ORDER BY date`, args: [s, e, ...bp] });
    const { rows: byMethod } = await db.execute({ sql: `SELECT payment_method, COUNT(*) as count, SUM(total) as total FROM transactions WHERE status='completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY payment_method`, args: [s, e, ...bp] });

    res.json({ summary, byDay, byMethod });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Top selling products
router.get('/top-products', async (req, res) => {
  try {
    const { start, end, limit = 10, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: products } = await db.execute({ sql: `SELECT ti.product_name, ti.sku, SUM(ti.quantity) as units_sold, SUM(ti.total) as revenue, COUNT(DISTINCT ti.transaction_id) as transactions FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY ti.product_id ORDER BY units_sold DESC LIMIT ?`, args: [s, e, ...bp, parseInt(limit)] });
    res.json(products);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sales by category
router.get('/by-category', async (req, res) => {
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
router.get('/inventory', async (req, res) => {
  try {
    const { branch_id } = req.query;
    const bf = branch_id ? ' AND bi.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({ sql: `SELECT COUNT(*) as total_products, SUM(stock_qty) as total_units, SUM(stock_qty * cost) as cost_value, SUM(stock_qty * price) as retail_value FROM products WHERE active = 1`, args: [] });
    const { rows: lowStock } = await db.execute({ sql: `SELECT p.sku, p.name, c.name as category_name, b.name as branch_name, bi.stock_qty, bi.min_stock FROM branch_inventory bi JOIN products p ON bi.product_id = p.id JOIN branches b ON bi.branch_id = b.id LEFT JOIN categories c ON p.category_id = c.id WHERE p.active=1 AND b.active=1 AND bi.stock_qty <= bi.min_stock${bf} ORDER BY bi.stock_qty ASC, b.name ASC`, args: [...bp] });
    const { rows: byCategory } = await db.execute({ sql: `SELECT c.name as category, COUNT(p.id) as products, SUM(p.stock_qty) as units, SUM(p.stock_qty * p.cost) as cost_value FROM products p JOIN categories c ON p.category_id = c.id WHERE p.active=1 GROUP BY c.id`, args: [] });
    res.json({ summary, lowStock, byCategory });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dashboard stats
router.get('/dashboard', async (req, res) => {
  try {
    const { branch_id } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];
    const warehouseExclude = `AND t.branch_id NOT IN (SELECT id FROM branches WHERE is_warehouse = 1)`;

    const { rows: [todayStats] } = await db.execute({ sql: `SELECT COUNT(*) as transactions, COALESCE(SUM(total),0) as sales FROM transactions t WHERE t.status='completed' AND date(t.created_at) = date(?) ${warehouseExclude}${bf}`, args: [today, ...bp] });
    const { rows: [monthStats] } = await db.execute({ sql: `SELECT COUNT(*) as transactions, COALESCE(SUM(total),0) as sales FROM transactions t WHERE t.status='completed' AND date(t.created_at) >= date(?) ${warehouseExclude}${bf}`, args: [monthStart, ...bp] });
    const { rows: [totalCustomers] } = await db.execute({ sql: 'SELECT COUNT(*) as count FROM customers WHERE active=1', args: [] });
    const { rows: [lowStock] } = await db.execute({ sql: 'SELECT COUNT(*) as count FROM products WHERE active=1 AND stock_qty <= min_stock', args: [] });
    const { rows: recentTx } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id WHERE t.branch_id NOT IN (SELECT id FROM branches WHERE is_warehouse = 1)${bf} ORDER BY t.created_at DESC LIMIT 5`, args: [...bp] });
    const { rows: last7Days } = await db.execute({ sql: `SELECT date(t.created_at) as date, COALESCE(SUM(t.total),0) as sales, COUNT(*) as transactions FROM transactions t WHERE t.status='completed' AND date(t.created_at) >= date('now', '-6 days') ${warehouseExclude}${bf} GROUP BY date(t.created_at) ORDER BY date`, args: [...bp] });

    const { rows: byLocation } = await db.execute({ sql: `SELECT b.id, b.name, b.city, b.state,
        COALESCE(SUM(CASE WHEN date(t.created_at) = date(?) THEN t.total ELSE 0 END), 0) as today_sales,
        COUNT(CASE WHEN date(t.created_at) = date(?) THEN 1 END) as today_transactions,
        COALESCE(SUM(CASE WHEN date(t.created_at) >= date(?) THEN t.total ELSE 0 END), 0) as month_sales,
        COUNT(CASE WHEN date(t.created_at) >= date(?) THEN 1 END) as month_transactions
      FROM branches b
      LEFT JOIN transactions t ON t.branch_id = b.id AND t.status = 'completed'
      WHERE b.active = 1 AND b.is_warehouse = 0
      GROUP BY b.id
      ORDER BY b.name`, args: [today, today, monthStart, monthStart] });

    res.json({ todayStats, monthStats, totalCustomers, lowStock, recentTx, last7Days, byLocation });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AR Collections report
router.get('/ar-collections', async (req, res) => {
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
router.get('/promotions', async (req, res) => {
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
