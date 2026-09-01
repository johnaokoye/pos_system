const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission, requireAnyPermission } = require('../lib/permissions');

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

// Special Projects margin report — realized/quoted margin per project, from
// quotation_items.unit_cost vs unit_price (see routes/quotations.js). Gated
// by special_projects/special_projects_approve, not the general `reports`
// permission — cost data on individually-negotiated deals is exactly what
// Special Projects is meant to keep restricted, same as the module itself.
router.get('/special-projects-margin', requireAnyPermission('special_projects', 'special_projects_approve'), async (req, res) => {
  try {
    const { start, end, branch_id, status } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND q.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];
    const sf = status ? ' AND q.status = ?' : '';
    const sp = status ? [status] : [];

    const { rows: projects } = await db.execute({
      sql: `SELECT q.id, q.quote_number, q.status, q.created_at, q.total as quote_total,
              c.first_name || ' ' || c.last_name as customer_name,
              e.first_name || ' ' || e.last_name as employee_name,
              oe.first_name || ' ' || oe.last_name as original_employee_name,
              COUNT(qi.id) as item_count,
              COALESCE(SUM(qi.total), 0) as revenue,
              COALESCE(SUM(COALESCE(qi.unit_cost, 0) * qi.quantity), 0) as cost,
              SUM(CASE WHEN qi.unit_cost IS NULL THEN 1 ELSE 0 END) as missing_cost_count
            FROM quotations q
            JOIN quotation_items qi ON qi.quote_id = q.id
            LEFT JOIN customers c ON q.customer_id = c.id
            LEFT JOIN employees e ON q.employee_id = e.id
            LEFT JOIN employees oe ON q.original_employee_id = oe.id
            WHERE q.quote_type = 'special_project' AND date(q.created_at) BETWEEN date(?) AND date(?)${bf}${sf}
            GROUP BY q.id
            ORDER BY q.created_at DESC`,
      args: [s, e, ...bp, ...sp],
    });
    // margin/margin_percent aren't stored — derive per project here so a
    // project with zero revenue (no lines priced yet) reports null% instead
    // of a divide-by-zero.
    for (const p of projects) {
      p.margin = parseFloat((p.revenue - p.cost).toFixed(2));
      p.margin_percent = p.revenue > 0 ? parseFloat((p.margin / p.revenue * 100).toFixed(2)) : null;
    }

    const totalRevenue = projects.reduce((sum, p) => sum + p.revenue, 0);
    const totalCost = projects.reduce((sum, p) => sum + p.cost, 0);
    const totalMargin = parseFloat((totalRevenue - totalCost).toFixed(2));
    const summary = {
      project_count: projects.length,
      total_revenue: parseFloat(totalRevenue.toFixed(2)),
      total_cost: parseFloat(totalCost.toFixed(2)),
      total_margin: totalMargin,
      // Blended margin (total $ / total $), not an average of each
      // project's own %, so a handful of big low-margin deals correctly
      // pull the headline number down instead of being diluted by many
      // small high-margin ones.
      margin_percent: totalRevenue > 0 ? parseFloat((totalMargin / totalRevenue * 100).toFixed(2)) : null,
      lines_missing_cost: projects.reduce((sum, p) => sum + (p.missing_cost_count || 0), 0),
    };

    // Same figures grouped by salesperson (original_employee_id — the
    // commission-credit target, same field PATCH /quotations/:id/reassign
    // and the transaction commission lookup already use) instead of per
    // project, for a "who's bringing in the most profitable work" view.
    const { rows: bySalesperson } = await db.execute({
      sql: `SELECT COALESCE(oe.id, e.id) as employee_id, COALESCE(oe.first_name || ' ' || oe.last_name, e.first_name || ' ' || e.last_name, 'Unassigned') as employee_name,
              COUNT(DISTINCT q.id) as project_count,
              COALESCE(SUM(qi.total), 0) as revenue,
              COALESCE(SUM(COALESCE(qi.unit_cost, 0) * qi.quantity), 0) as cost
            FROM quotations q
            JOIN quotation_items qi ON qi.quote_id = q.id
            LEFT JOIN employees e ON q.employee_id = e.id
            LEFT JOIN employees oe ON q.original_employee_id = oe.id
            WHERE q.quote_type = 'special_project' AND date(q.created_at) BETWEEN date(?) AND date(?)${bf}${sf}
            GROUP BY COALESCE(oe.id, e.id)
            ORDER BY revenue DESC`,
      args: [s, e, ...bp, ...sp],
    });
    for (const row of bySalesperson) {
      const margin = parseFloat((row.revenue - row.cost).toFixed(2));
      row.margin = margin;
      row.margin_percent = row.revenue > 0 ? parseFloat((margin / row.revenue * 100).toFixed(2)) : null;
    }

    res.json({ summary, projects, bySalesperson });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Marketing reports ──────────────────────────────────────────────────────

// Lead source performance — crm_leads.source through to crm_opportunities.won.
// crm_leads has no converted_to_opportunity link of its own; the join runs
// the other way (crm_opportunities.lead_id -> crm_leads.id).
router.get('/lead-source-performance', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);

    const { rows: bySource } = await db.execute({
      sql: `SELECT l.source,
              COUNT(DISTINCT l.id) as lead_count,
              COUNT(DISTINCT o.id) as opportunity_count,
              COUNT(DISTINCT CASE WHEN o.won = 1 THEN o.id END) as won_count,
              COALESCE(SUM(CASE WHEN o.won = 1 THEN o.value ELSE 0 END), 0) as won_value
            FROM crm_leads l
            LEFT JOIN crm_opportunities o ON o.lead_id = l.id
            WHERE date(l.created_at) BETWEEN date(?) AND date(?)
            GROUP BY l.source
            ORDER BY lead_count DESC`,
      args: [s, e],
    });
    for (const row of bySource) {
      row.lead_to_opp_rate = row.lead_count > 0 ? parseFloat((row.opportunity_count / row.lead_count * 100).toFixed(1)) : 0;
      row.win_rate = row.opportunity_count > 0 ? parseFloat((row.won_count / row.opportunity_count * 100).toFixed(1)) : null;
      row.lead_to_won_rate = row.lead_count > 0 ? parseFloat((row.won_count / row.lead_count * 100).toFixed(1)) : 0;
    }
    const totals = bySource.reduce((acc, r) => ({
      lead_count: acc.lead_count + r.lead_count,
      opportunity_count: acc.opportunity_count + r.opportunity_count,
      won_count: acc.won_count + r.won_count,
      won_value: acc.won_value + r.won_value,
    }), { lead_count: 0, opportunity_count: 0, won_count: 0, won_value: 0 });
    totals.lead_to_won_rate = totals.lead_count > 0 ? parseFloat((totals.won_count / totals.lead_count * 100).toFixed(1)) : 0;

    res.json({ totals, bySource });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Customer segment report — sales/margin by customer_category_id. Revenue
// and cost are queried separately (not one item-joined query) because
// joining transaction_items would fan out the transaction-level subtotal/
// discount figures once per line — see the two-query-merge pattern below.
router.get('/customer-segments', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: revenueRows } = await db.execute({
      sql: `SELECT cc.id as category_id, cc.name as category_name, cc.discount_percent,
              COUNT(DISTINCT t.id) as order_count,
              COUNT(DISTINCT t.customer_id) as customer_count,
              COALESCE(SUM(t.subtotal - t.discount_amount), 0) as revenue,
              COALESCE(SUM(t.discount_amount), 0) as total_discount
            FROM customer_categories cc
            LEFT JOIN customers c ON c.customer_category_id = cc.id
            LEFT JOIN transactions t ON t.customer_id = c.id AND t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            WHERE cc.active = 1
            GROUP BY cc.id
            ORDER BY revenue DESC`,
      args: [s, e, ...bp],
    });
    const { rows: costRows } = await db.execute({
      sql: `SELECT cc.id as category_id, COALESCE(SUM(ti.quantity * COALESCE(p.cost, 0)), 0) as cost
            FROM customer_categories cc
            LEFT JOIN customers c ON c.customer_category_id = cc.id
            LEFT JOIN transactions t ON t.customer_id = c.id AND t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
            LEFT JOIN products p ON ti.product_id = p.id
            WHERE cc.active = 1
            GROUP BY cc.id`,
      args: [s, e, ...bp],
    });
    // Customers with no category at all — a baseline to compare segments against.
    const { rows: [uncategorized] } = await db.execute({
      sql: `SELECT COUNT(DISTINCT t.id) as order_count, COUNT(DISTINCT t.customer_id) as customer_count,
              COALESCE(SUM(t.subtotal - t.discount_amount), 0) as revenue, COALESCE(SUM(t.discount_amount), 0) as total_discount
            FROM transactions t JOIN customers c ON t.customer_id = c.id
            WHERE c.customer_category_id IS NULL AND t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });
    const { rows: [uncategorizedCost] } = await db.execute({
      sql: `SELECT COALESCE(SUM(ti.quantity * COALESCE(p.cost, 0)), 0) as cost
            FROM transactions t JOIN customers c ON t.customer_id = c.id
            JOIN transaction_items ti ON ti.transaction_id = t.id
            LEFT JOIN products p ON ti.product_id = p.id
            WHERE c.customer_category_id IS NULL AND t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });

    const costByCategory = {};
    for (const row of costRows) costByCategory[row.category_id] = row.cost;
    const segments = revenueRows.map(r => {
      const cost = costByCategory[r.category_id] || 0;
      const margin = parseFloat((r.revenue - cost).toFixed(2));
      return { ...r, cost, margin, margin_percent: r.revenue > 0 ? parseFloat((margin / r.revenue * 100).toFixed(1)) : null };
    });
    const noCategoryMargin = parseFloat((uncategorized.revenue - uncategorizedCost.cost).toFixed(2));
    segments.push({
      category_id: null, category_name: 'No Category', discount_percent: 0,
      order_count: uncategorized.order_count, customer_count: uncategorized.customer_count,
      revenue: uncategorized.revenue, total_discount: uncategorized.total_discount, cost: uncategorizedCost.cost,
      margin: noCategoryMargin, margin_percent: uncategorized.revenue > 0 ? parseFloat((noCategoryMargin / uncategorized.revenue * 100).toFixed(1)) : null,
    });

    res.json({ segments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Loyalty & cash-back engagement. There's no historical points ledger (only
// a running customers.loyalty_points balance), so "points issued" is
// reconstructed by re-applying the same 0.5-point-per-$1 rate POST
// /transactions itself uses (routes/transactions.js) over completed sales
// in range — accurate for what's actually stored, but not a true audit log.
router.get('/loyalty-engagement', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [issued] } = await db.execute({
      sql: `SELECT COALESCE(SUM(CAST(t.total * 0.5 AS INTEGER)), 0) as points_issued, COUNT(*) as earning_transactions
            FROM transactions t WHERE t.status='completed' AND t.customer_id IS NOT NULL AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });
    // Points-equivalent redeemed is approximated using each customer's
    // CURRENT cash-back card type — if a customer switched card types since
    // a given redemption, that historical redemption is valued at today's
    // reward ratio, not the one in effect at the time.
    const { rows: [redeemed] } = await db.execute({
      sql: `SELECT COALESCE(SUM(t.cash_back_applied), 0) as cash_redeemed, COUNT(*) as redemption_count,
              COALESCE(SUM(t.cash_back_applied / NULLIF(cbct.reward_amount, 0) * cbct.points_threshold), 0) as points_redeemed_equiv
            FROM transactions t
            LEFT JOIN customers c ON t.customer_id = c.id
            LEFT JOIN cash_back_card_types cbct ON c.cash_back_card_type_id = cbct.id
            WHERE t.status='completed' AND t.cash_back_applied > 0 AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });
    const { rows: topEarners } = await db.execute({
      sql: `SELECT t.customer_id, c.first_name || ' ' || c.last_name as customer_name, c.customer_number,
              COALESCE(SUM(CAST(t.total * 0.5 AS INTEGER)), 0) as points_earned, c.loyalty_points as current_balance
            FROM transactions t JOIN customers c ON t.customer_id = c.id
            WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY t.customer_id ORDER BY points_earned DESC LIMIT 10`,
      args: [s, e, ...bp],
    });

    const points_issued = issued.points_issued || 0;
    const points_redeemed_equiv = parseFloat((redeemed.points_redeemed_equiv || 0).toFixed(0));
    const redemption_rate = points_issued > 0 ? parseFloat((points_redeemed_equiv / points_issued * 100).toFixed(1)) : null;

    res.json({
      summary: {
        points_issued, earning_transactions: issued.earning_transactions,
        cash_redeemed: parseFloat((redeemed.cash_redeemed || 0).toFixed(2)), redemption_count: redeemed.redemption_count,
        points_redeemed_equiv, redemption_rate,
      },
      topEarners,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Discount card utilization. There's no dedicated discount-card-usage FK on
// transactions (see routes/customers.js's validateDiscountCard /
// public/index.html's checkout flow) — a card's use is recorded by
// repurposing transactions.promotion_name to "{type} Discount Card", so
// usage here is detected the same way, not via a real foreign key.
router.get('/discount-card-utilization', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: issuedByType } = await db.execute({
      sql: `SELECT dct.id as type_id, dct.name, dct.discount_percent, dct.active,
              COUNT(c.id) as cards_issued
            FROM discount_card_types dct
            LEFT JOIN customers c ON c.discount_card_type_id = dct.id AND c.discount_card_number IS NOT NULL AND c.discount_card_number != ''
            GROUP BY dct.id
            ORDER BY cards_issued DESC`,
      args: [],
    });
    const { rows: usedByType } = await db.execute({
      sql: `SELECT c.discount_card_type_id as type_id,
              COUNT(DISTINCT t.id) as uses, COUNT(DISTINCT t.customer_id) as customers_used,
              COALESCE(SUM(t.discount_amount), 0) as total_discount_given
            FROM transactions t JOIN customers c ON t.customer_id = c.id
            WHERE t.status='completed' AND t.promotion_name LIKE '%Discount Card%' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY c.discount_card_type_id`,
      args: [s, e, ...bp],
    });
    const usedMap = {};
    for (const row of usedByType) usedMap[row.type_id] = row;
    const byType = issuedByType.map(t => {
      const used = usedMap[t.type_id] || { uses: 0, customers_used: 0, total_discount_given: 0 };
      return { ...t, uses: used.uses, customers_used: used.customers_used, total_discount_given: used.total_discount_given,
        utilization_rate: t.cards_issued > 0 ? parseFloat((used.customers_used / t.cards_issued * 100).toFixed(1)) : null };
    });

    const { rows: [neverUsedCount] } = await db.execute({
      sql: `SELECT COUNT(*) as c FROM customers c
            WHERE c.discount_card_number IS NOT NULL AND c.discount_card_number != '' AND c.active = 1
              AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id AND t.status='completed' AND t.promotion_name LIKE '%Discount Card%' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf})`,
      args: [s, e, ...bp],
    });
    const { rows: neverUsed } = await db.execute({
      sql: `SELECT c.id, c.customer_number, c.first_name || ' ' || c.last_name as customer_name, dct.name as card_type, c.discount_card_number
            FROM customers c JOIN discount_card_types dct ON c.discount_card_type_id = dct.id
            WHERE c.discount_card_number IS NOT NULL AND c.discount_card_number != '' AND c.active = 1
              AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id AND t.status='completed' AND t.promotion_name LIKE '%Discount Card%' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf})
            ORDER BY c.first_name LIMIT 50`,
      args: [s, e, ...bp],
    });

    const totalIssued = byType.reduce((sum, t) => sum + t.cards_issued, 0);
    const totalUsed = byType.reduce((sum, t) => sum + t.customers_used, 0);
    res.json({
      summary: { total_issued: totalIssued, total_used: totalUsed, utilization_rate: totalIssued > 0 ? parseFloat((totalUsed / totalIssued * 100).toFixed(1)) : null, never_used_count: neverUsedCount.c },
      byType, neverUsed,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// New vs. repeat customer rate. "New" = a customer's first-ever completed
// transaction falls inside the selected range; "repeat" = they transacted
// in-range but their first-ever purchase was earlier.
router.get('/customer-retention', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({
      sql: `WITH first_tx AS (
              SELECT customer_id, MIN(date(created_at)) as first_date
              FROM transactions WHERE status='completed' AND customer_id IS NOT NULL
              GROUP BY customer_id
            ),
            active AS (
              SELECT DISTINCT t.customer_id, t.total, t.id
              FROM transactions t
              WHERE t.status='completed' AND t.customer_id IS NOT NULL AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            )
            SELECT
              COUNT(DISTINCT CASE WHEN ft.first_date >= date(?) THEN a.customer_id END) as new_customers,
              COUNT(DISTINCT CASE WHEN ft.first_date < date(?) THEN a.customer_id END) as repeat_customers,
              COALESCE(SUM(CASE WHEN ft.first_date >= date(?) THEN a.total ELSE 0 END), 0) as new_revenue,
              COALESCE(SUM(CASE WHEN ft.first_date < date(?) THEN a.total ELSE 0 END), 0) as repeat_revenue
            FROM active a JOIN first_tx ft ON ft.customer_id = a.customer_id`,
      args: [s, e, ...bp, s, s, s, s],
    });
    const { rows: byDay } = await db.execute({
      sql: `WITH first_tx AS (
              SELECT customer_id, MIN(date(created_at)) as first_date
              FROM transactions WHERE status='completed' AND customer_id IS NOT NULL
              GROUP BY customer_id
            )
            SELECT date(t.created_at) as date,
              COUNT(DISTINCT CASE WHEN ft.first_date = date(t.created_at) THEN t.customer_id END) as new_customers,
              COUNT(DISTINCT CASE WHEN ft.first_date != date(t.created_at) THEN t.customer_id END) as repeat_customers
            FROM transactions t JOIN first_tx ft ON ft.customer_id = t.customer_id
            WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY date(t.created_at) ORDER BY date`,
      args: [s, e, ...bp],
    });

    const totalActive = summary.new_customers + summary.repeat_customers;
    summary.new_rate = totalActive > 0 ? parseFloat((summary.new_customers / totalActive * 100).toFixed(1)) : null;
    summary.repeat_rate = totalActive > 0 ? parseFloat((summary.repeat_customers / totalActive * 100).toFixed(1)) : null;

    res.json({ summary, byDay });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Sales reports ──────────────────────────────────────────────────────────

// Salesperson leaderboard — quotes created/converted, win rate, credited
// sales, keyed off original_employee_id (the commission-credit target;
// same field PATCH /quotations/:id/reassign and the transaction commission
// lookup in routes/transactions.js already use). Covers every quote_type;
// "credited sales" is the quote's own quoted total, not the possibly-edited
// final transaction amount — a performance view, not a financial reconciliation.
router.get('/salesperson-leaderboard', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, quote_type } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const tf = quote_type ? ' AND q.quote_type = ?' : '';
    const tp = quote_type ? [quote_type] : [];

    const { rows } = await db.execute({
      sql: `SELECT COALESCE(oe.id, e.id) as employee_id, COALESCE(oe.first_name || ' ' || oe.last_name, e.first_name || ' ' || e.last_name, 'Unassigned') as employee_name,
              COUNT(DISTINCT q.id) as quotes_created,
              COUNT(DISTINCT CASE WHEN q.status = 'converted' THEN q.id END) as quotes_converted,
              COALESCE(SUM(CASE WHEN q.status = 'converted' THEN q.total ELSE 0 END), 0) as credited_sales
            FROM quotations q
            LEFT JOIN employees e ON q.employee_id = e.id
            LEFT JOIN employees oe ON q.original_employee_id = oe.id
            WHERE date(q.created_at) BETWEEN date(?) AND date(?)${tf}
            GROUP BY COALESCE(oe.id, e.id)
            ORDER BY credited_sales DESC`,
      args: [s, e, ...tp],
    });
    for (const row of rows) {
      row.win_rate = row.quotes_created > 0 ? parseFloat((row.quotes_converted / row.quotes_created * 100).toFixed(1)) : 0;
    }
    const totals = rows.reduce((acc, r) => ({
      quotes_created: acc.quotes_created + r.quotes_created,
      quotes_converted: acc.quotes_converted + r.quotes_converted,
      credited_sales: acc.credited_sales + r.credited_sales,
    }), { quotes_created: 0, quotes_converted: 0, credited_sales: 0 });
    totals.win_rate = totals.quotes_created > 0 ? parseFloat((totals.quotes_converted / totals.quotes_created * 100).toFixed(1)) : 0;

    res.json({ totals, rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Quote funnel & cycle time. Current-status counts, plus average days spent
// per transition using quotations.sent_at/accepted_at (see database.js
// migration) — only stamped going forward, so older quotes and any quote
// that skipped a stage (e.g. converted straight from Draft) simply aren't
// counted in that specific stage's average, not treated as 0 days.
router.get('/quote-funnel', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, quote_type } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const tf = quote_type ? ' AND quote_type = ?' : '';
    const tp = quote_type ? [quote_type] : [];

    const { rows: funnel } = await db.execute({
      sql: `SELECT status, COUNT(*) as count FROM quotations WHERE date(created_at) BETWEEN date(?) AND date(?)${tf} GROUP BY status ORDER BY count DESC`,
      args: [s, e, ...tp],
    });

    const tfAliased = quote_type ? ' AND q.quote_type = ?' : '';
    const { rows: [stages] } = await db.execute({
      sql: `SELECT
              AVG(CASE WHEN sent_at IS NOT NULL THEN julianday(sent_at) - julianday(created_at) END) as draft_to_sent_days,
              COUNT(CASE WHEN sent_at IS NOT NULL THEN 1 END) as draft_to_sent_n,
              AVG(CASE WHEN accepted_at IS NOT NULL AND sent_at IS NOT NULL THEN julianday(accepted_at) - julianday(sent_at) END) as sent_to_accepted_days,
              COUNT(CASE WHEN accepted_at IS NOT NULL AND sent_at IS NOT NULL THEN 1 END) as sent_to_accepted_n,
              AVG(CASE WHEN submitted_at IS NOT NULL THEN julianday(submitted_at) - julianday(created_at) END) as draft_to_submitted_days,
              COUNT(CASE WHEN submitted_at IS NOT NULL THEN 1 END) as draft_to_submitted_n,
              AVG(CASE WHEN approved_at IS NOT NULL AND submitted_at IS NOT NULL THEN julianday(approved_at) - julianday(submitted_at) END) as submitted_to_approved_days,
              COUNT(CASE WHEN approved_at IS NOT NULL AND submitted_at IS NOT NULL THEN 1 END) as submitted_to_approved_n
            FROM quotations WHERE date(created_at) BETWEEN date(?) AND date(?)${tf}`,
      args: [s, e, ...tp],
    });
    // Needs a join (converted-to timestamp lives on the linked transaction
    // or rental agreement, not on quotations itself), so it's a separate query.
    const { rows: [convertedStage] } = await db.execute({
      sql: `SELECT AVG(julianday(COALESCE(t.created_at, ra.created_at)) - julianday(q.accepted_at)) as accepted_to_converted_days, COUNT(*) as accepted_to_converted_n
            FROM quotations q
            LEFT JOIN transactions t ON t.id = q.converted_to_tx
            LEFT JOIN rental_agreements ra ON ra.id = q.converted_to_agreement_id
            WHERE q.accepted_at IS NOT NULL AND q.status = 'converted' AND date(q.created_at) BETWEEN date(?) AND date(?)${tfAliased}`,
      args: [s, e, ...tp],
    });

    const round1 = v => v == null ? null : parseFloat(v.toFixed(1));
    const cycleTimes = [
      { stage: 'Draft → Sent', avg_days: round1(stages.draft_to_sent_days), sample_size: stages.draft_to_sent_n },
      { stage: 'Sent → Accepted', avg_days: round1(stages.sent_to_accepted_days), sample_size: stages.sent_to_accepted_n },
      { stage: 'Accepted → Converted', avg_days: round1(convertedStage.accepted_to_converted_days), sample_size: convertedStage.accepted_to_converted_n },
      { stage: 'Draft → Submitted for Approval (Special Projects)', avg_days: round1(stages.draft_to_submitted_days), sample_size: stages.draft_to_submitted_n },
      { stage: 'Submitted → Approved (Special Projects)', avg_days: round1(stages.submitted_to_approved_days), sample_size: stages.submitted_to_approved_n },
    ];

    res.json({ funnel, cycleTimes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CRM pipeline / weighted forecast — open opportunities (won=0, no
// lost_reason) by stage, weighted by probability. Opportunities with no
// expected_close date are always included regardless of the date filter —
// they're still real open pipeline, just undated.
router.get('/crm-pipeline', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end } = req.query;
    const s = start || new Date().toISOString().slice(0, 10);
    const e = end || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

    const { rows: byStage } = await db.execute({
      sql: `SELECT o.stage, COUNT(*) as opp_count, COALESCE(SUM(o.value), 0) as total_value,
              COALESCE(SUM(o.value * o.probability / 100.0), 0) as weighted_value,
              ROUND(AVG(o.probability)) as avg_probability
            FROM crm_opportunities o
            WHERE o.won = 0 AND o.lost_reason IS NULL
              AND (o.expected_close IS NULL OR date(o.expected_close) BETWEEN date(?) AND date(?))
            GROUP BY o.stage
            ORDER BY weighted_value DESC`,
      args: [s, e],
    });
    const { rows: top } = await db.execute({
      sql: `SELECT o.id, o.opp_number, o.title, o.stage, o.value, o.probability, o.expected_close,
              c.first_name || ' ' || c.last_name as customer_name, emp.first_name || ' ' || emp.last_name as employee_name
            FROM crm_opportunities o
            LEFT JOIN customers c ON o.customer_id = c.id
            LEFT JOIN employees emp ON o.employee_id = emp.id
            WHERE o.won = 0 AND o.lost_reason IS NULL
              AND (o.expected_close IS NULL OR date(o.expected_close) BETWEEN date(?) AND date(?))
            ORDER BY (o.value * o.probability / 100.0) DESC
            LIMIT 10`,
      args: [s, e],
    });
    const totals = byStage.reduce((acc, r) => ({
      opp_count: acc.opp_count + r.opp_count,
      total_value: acc.total_value + r.total_value,
      weighted_value: acc.weighted_value + r.weighted_value,
    }), { opp_count: 0, total_value: 0, weighted_value: 0 });

    res.json({ totals, byStage, top });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rental utilization — bookings/revenue per rental item. Only top-level
// lines (parent_item_id IS NULL) count — bundled/optional accessory child
// rows would otherwise double-count activity against the parent item.
router.get('/rental-utilization', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND ra.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: items } = await db.execute({
      sql: `SELECT rai.product_id, rai.product_name,
              COUNT(DISTINCT rai.agreement_id) as booking_count,
              COALESCE(SUM(rai.quantity), 0) as total_quantity_booked,
              COALESCE(SUM(rai.final_rental_fee), 0) as revenue,
              MAX(p.stock_qty) as units_owned
            FROM rental_agreement_items rai
            JOIN rental_agreements ra ON rai.agreement_id = ra.id
            LEFT JOIN products p ON rai.product_id = p.id
            WHERE rai.parent_item_id IS NULL AND ra.status != 'cancelled' AND date(ra.checkout_date) BETWEEN date(?) AND date(?)${bf}
            GROUP BY rai.product_id, rai.product_name
            ORDER BY revenue DESC`,
      args: [s, e, ...bp],
    });
    const { rows: activeNow } = await db.execute({
      sql: `SELECT rai.product_id, COUNT(*) as currently_out
            FROM rental_agreement_items rai JOIN rental_agreements ra ON rai.agreement_id = ra.id
            WHERE rai.parent_item_id IS NULL AND ra.status = 'active'
            GROUP BY rai.product_id`,
      args: [],
    });
    const activeMap = {};
    for (const row of activeNow) activeMap[row.product_id] = row.currently_out;
    for (const item of items) item.currently_out = activeMap[item.product_id] || 0;

    const totals = items.reduce((acc, r) => ({
      booking_count: acc.booking_count + r.booking_count,
      revenue: acc.revenue + r.revenue,
    }), { booking_count: 0, revenue: 0 });

    res.json({ totals, items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Accounts reports ───────────────────────────────────────────────────────

// Cash drawer variance trend — counted cash vs. expected cash (opening
// float + cash sales that hit the drawer) on every reconciled session in
// range. Expected cash is computed with the exact same per-session cash
// tender subquery GET /drawers/sessions/:id already uses (split-tender
// legs from transaction_payments, falling back to the whole transaction
// for anything with no payment legs) — so this never disagrees with what
// staff saw on the reconciliation screen itself.
router.get('/cash-variance', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND ds.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: sessions } = await db.execute({
      sql: `SELECT dr.id as reconciliation_id, ds.id as session_id, dr.reconciled_at,
              ds.employee_id, e.first_name || ' ' || e.last_name as employee_name,
              ds.branch_id, b.name as branch_name, ds.opening_float, dr.cash_counted,
              (
                SELECT COALESCE(SUM(amount), 0) FROM (
                  SELECT tp.amount FROM transaction_payments tp JOIN transactions t ON t.id = tp.transaction_id
                  WHERE t.drawer_session_id = ds.id AND tp.payment_method = 'cash'
                  UNION ALL
                  SELECT t.total FROM transactions t
                  WHERE t.drawer_session_id = ds.id AND t.payment_method = 'cash'
                    AND NOT EXISTS (SELECT 1 FROM transaction_payments tp2 WHERE tp2.transaction_id = t.id)
                )
              ) as cash_sales
            FROM drawer_reconciliations dr
            JOIN drawer_sessions ds ON dr.session_id = ds.id
            LEFT JOIN employees e ON ds.employee_id = e.id
            LEFT JOIN branches b ON ds.branch_id = b.id
            WHERE date(dr.reconciled_at) BETWEEN date(?) AND date(?)${bf}
            ORDER BY dr.reconciled_at DESC`,
      args: [s, e, ...bp],
    });
    for (const row of sessions) {
      row.expected_cash = parseFloat((row.opening_float + row.cash_sales).toFixed(2));
      row.variance = parseFloat((row.cash_counted - row.expected_cash).toFixed(2));
    }

    const byGroup = (keyFn, nameFn) => {
      const map = new Map();
      for (const row of sessions) {
        const key = keyFn(row);
        if (!map.has(key)) map.set(key, { key, name: nameFn(row), session_count: 0, total_variance: 0, over_count: 0, short_count: 0 });
        const g = map.get(key);
        g.session_count++;
        g.total_variance = parseFloat((g.total_variance + row.variance).toFixed(2));
        if (row.variance > 0.005) g.over_count++;
        else if (row.variance < -0.005) g.short_count++;
      }
      return [...map.values()].map(g => ({ ...g, avg_variance: parseFloat((g.total_variance / g.session_count).toFixed(2)) }))
        .sort((a, b) => a.total_variance - b.total_variance);
    };
    const byEmployee = byGroup(r => r.employee_id ?? 'null', r => r.employee_name || 'Unassigned');
    const byBranch = byGroup(r => r.branch_id ?? 'null', r => r.branch_name || 'No Branch');

    const totalVariance = sessions.reduce((sum, r) => sum + r.variance, 0);
    res.json({
      summary: {
        session_count: sessions.length,
        total_variance: parseFloat(totalVariance.toFixed(2)),
        over_count: sessions.filter(r => r.variance > 0.005).length,
        short_count: sessions.filter(r => r.variance < -0.005).length,
      },
      byEmployee, byBranch, sessions,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Credit risk / exposure — every credit-enabled customer's balance vs.
// limit, block status, and (for anyone not yet blocked with a balance
// outstanding) days remaining before runCreditCheck (routes/customers.js)
// would auto-block them, using the exact same aging rule: days since the
// oldest unpaid credit sale vs. credit_terms_days.
router.get('/credit-risk', requirePermission('reports'), async (req, res) => {
  try {
    const { rows: customers } = await db.execute({
      sql: `SELECT c.id, c.customer_number, c.first_name || ' ' || c.last_name as customer_name,
              c.credit_limit, c.account_balance, c.account_blocked, c.credit_terms_days,
              (SELECT MIN(created_at) FROM transactions WHERE customer_id = c.id AND payment_method = 'credit' AND status = 'completed') as oldest_unpaid_date
            FROM customers c
            WHERE c.credit_enabled = 1 AND c.active = 1 AND c.account_balance > 0
            ORDER BY c.account_balance DESC`,
      args: [],
    });
    for (const c of customers) {
      c.pct_of_limit = c.credit_limit > 0 ? parseFloat((c.account_balance / c.credit_limit * 100).toFixed(1)) : null;
      c.risk_level = c.account_blocked ? 'blocked' : (c.pct_of_limit != null && c.pct_of_limit >= 100) ? 'over_limit' : (c.pct_of_limit != null && c.pct_of_limit >= 80) ? 'near_limit' : 'ok';
      if (c.account_blocked || !c.oldest_unpaid_date) {
        c.days_to_block = null;
      } else {
        const daysSince = Math.floor((Date.now() - new Date(c.oldest_unpaid_date).getTime()) / 86400000);
        c.days_to_block = (c.credit_terms_days || 30) - daysSince;
      }
    }
    const summary = {
      at_risk_count: customers.length,
      blocked_count: customers.filter(c => c.account_blocked).length,
      over_limit_count: customers.filter(c => c.risk_level === 'over_limit').length,
      near_limit_count: customers.filter(c => c.risk_level === 'near_limit').length,
      total_exposure: parseFloat(customers.reduce((sum, c) => sum + c.account_balance, 0).toFixed(2)),
    };
    res.json({ summary, customers });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Tax collected — sized for filing: taxable sales (subtotal) alongside tax
// actually collected, by day and by branch.
router.get('/tax-collected', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({
      sql: `SELECT COUNT(*) as tx_count, COALESCE(SUM(subtotal), 0) as taxable_sales, COALESCE(SUM(tax_amount), 0) as tax_collected
            FROM transactions WHERE status = 'completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });
    const { rows: byDay } = await db.execute({
      sql: `SELECT date(created_at) as date, COALESCE(SUM(subtotal), 0) as taxable_sales, COALESCE(SUM(tax_amount), 0) as tax_collected
            FROM transactions WHERE status = 'completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY date(created_at) ORDER BY date`,
      args: [s, e, ...bp],
    });
    const { rows: byBranch } = await db.execute({
      sql: `SELECT t.branch_id, b.name as branch_name, COALESCE(SUM(t.subtotal), 0) as taxable_sales, COALESCE(SUM(t.tax_amount), 0) as tax_collected
            FROM transactions t LEFT JOIN branches b ON t.branch_id = b.id
            WHERE t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY t.branch_id ORDER BY tax_collected DESC`,
      args: [s, e, ...bp],
    });
    summary.effective_rate = summary.taxable_sales > 0 ? parseFloat((summary.tax_collected / summary.taxable_sales * 100).toFixed(2)) : null;

    res.json({ summary, byDay, byBranch });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Write-off / bad debt — reads account_payments rows recorded via the new
// POST /accounts/writeoff (payment_method='writeoff'); see that endpoint's
// comment for why write-offs live in the same table as real payments.
router.get('/writeoffs', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND p.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({
      sql: `SELECT COUNT(*) as writeoff_count, COALESCE(SUM(amount), 0) as total_written_off
            FROM account_payments p WHERE p.payment_method = 'writeoff' AND date(p.created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });
    const { rows: byCustomer } = await db.execute({
      sql: `SELECT c.id as customer_id, c.customer_number, c.first_name || ' ' || c.last_name as customer_name,
              COUNT(*) as writeoff_count, COALESCE(SUM(p.amount), 0) as total_written_off
            FROM account_payments p JOIN customers c ON p.customer_id = c.id
            WHERE p.payment_method = 'writeoff' AND date(p.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY c.id ORDER BY total_written_off DESC`,
      args: [s, e, ...bp],
    });
    const { rows: byBranch } = await db.execute({
      sql: `SELECT p.branch_id, b.name as branch_name, COUNT(*) as writeoff_count, COALESCE(SUM(p.amount), 0) as total_written_off
            FROM account_payments p LEFT JOIN branches b ON p.branch_id = b.id
            WHERE p.payment_method = 'writeoff' AND date(p.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY p.branch_id ORDER BY total_written_off DESC`,
      args: [s, e, ...bp],
    });
    const { rows: records } = await db.execute({
      sql: `SELECT p.id, p.payment_number, p.amount, p.notes as reason, p.created_at,
              c.first_name || ' ' || c.last_name as customer_name, c.customer_number,
              emp.first_name || ' ' || emp.last_name as employee_name, b.name as branch_name
            FROM account_payments p
            JOIN customers c ON p.customer_id = c.id
            LEFT JOIN employees emp ON p.employee_id = emp.id
            LEFT JOIN branches b ON p.branch_id = b.id
            WHERE p.payment_method = 'writeoff' AND date(p.created_at) BETWEEN date(?) AND date(?)${bf}
            ORDER BY p.created_at DESC`,
      args: [s, e, ...bp],
    });

    res.json({ summary, byCustomer, byBranch, records });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Gross margin (COGS) — the store-wide sibling of the Special Projects
// margin report and the Customer Segment report's margin calc: revenue and
// cost queried separately (not one item-joined query), so joining
// transaction_items doesn't fan out a transaction-level total.
router.get('/gross-margin', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({
      sql: `SELECT COALESCE(SUM(ti.total), 0) as revenue, COALESCE(SUM(ti.quantity * COALESCE(p.cost, 0)), 0) as cost
            FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id LEFT JOIN products p ON ti.product_id = p.id
            WHERE t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });
    summary.margin = parseFloat((summary.revenue - summary.cost).toFixed(2));
    summary.margin_percent = summary.revenue > 0 ? parseFloat((summary.margin / summary.revenue * 100).toFixed(1)) : null;

    const { rows: byCategory } = await db.execute({
      sql: `SELECT c.id as category_id, COALESCE(c.name, 'Uncategorized') as category_name,
              COALESCE(SUM(ti.total), 0) as revenue, COALESCE(SUM(ti.quantity * COALESCE(p.cost, 0)), 0) as cost
            FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
            LEFT JOIN products p ON ti.product_id = p.id LEFT JOIN categories c ON p.category_id = c.id
            WHERE t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY c.id ORDER BY revenue DESC`,
      args: [s, e, ...bp],
    });
    const { rows: byBranch } = await db.execute({
      sql: `SELECT t.branch_id, b.name as branch_name,
              COALESCE(SUM(ti.total), 0) as revenue, COALESCE(SUM(ti.quantity * COALESCE(p.cost, 0)), 0) as cost
            FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
            LEFT JOIN products p ON ti.product_id = p.id LEFT JOIN branches b ON t.branch_id = b.id
            WHERE t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY t.branch_id ORDER BY revenue DESC`,
      args: [s, e, ...bp],
    });
    for (const row of [...byCategory, ...byBranch]) {
      row.margin = parseFloat((row.revenue - row.cost).toFixed(2));
      row.margin_percent = row.revenue > 0 ? parseFloat((row.margin / row.revenue * 100).toFixed(1)) : null;
    }

    res.json({ summary, byCategory, byBranch });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
