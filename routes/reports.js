const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission, requireAnyPermission } = require('../lib/permissions');
const { SERIAL_NUMBER_SKU } = require('../lib/serialNumber');
const { refreshStoreTz, storeToday, storeOffsetModifier, storeDay } = require('../lib/storeTime');
const { oldestOpenLegacySql, oldestUnpaidSaleSql, earliestDate } = require('../lib/legacyInvoices');

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

// Top selling products — by number of transactions (frequency)
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

    // Ranked by frequency — how many completed tickets the item was on —
    // unless ?sort=units asks for the old by-quantity order.
    const order = req.query.sort === 'units' ? 'units_sold DESC, transactions DESC' : 'transactions DESC, units_sold DESC';
    // Per catalog item, under its current name/SKU (not the name on the
    // ticket line, which goes stale on a rename and carries variant/unit
    // suffixes). Left out — they aren't item sales:
    //  - SN lines: the $0 "SN" item that only carries a serial number
    //  - comment / delivery lines
    //  - rental checkout & settlement tickets: rental fees, "(included)"
    //    accessories and "Damage Fee — …" lines all sit on the rented item
    const { rows: products } = await db.execute({
      sql: `SELECT p.id as product_id, p.name as product_name, p.sku,
              SUM(ti.quantity * COALESCE(ti.units_per, 1)) as units_sold, SUM(ti.total) as revenue,
              COUNT(DISTINCT ti.transaction_id) as transactions
            FROM transaction_items ti
            JOIN transactions t ON ti.transaction_id = t.id
            JOIN products p ON ti.product_id = p.id
            WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}${cf}
              AND upper(COALESCE(p.sku, '')) != ? AND (ti.serial_number IS NULL OR ti.serial_number = '')
              AND COALESCE(ti.is_comment, 0) = 0 AND COALESCE(ti.is_delivery, 0) = 0
              AND NOT EXISTS (SELECT 1 FROM rental_agreements ra WHERE ra.checkout_transaction_id = t.id OR ra.settlement_transaction_id = t.id)
            GROUP BY p.id ORDER BY ${order} LIMIT ?`,
      args: [s, e, ...bp, ...cp, SERIAL_NUMBER_SKU, parseInt(limit)],
    });
    res.json(products);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sales by category — SN serial-number lines (the $0 SN carrier item) left out
router.get('/by-category', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: data } = await db.execute({ sql: `SELECT c.name as category, SUM(ti.quantity * COALESCE(ti.units_per, 1)) as units_sold, SUM(ti.total) as revenue FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id JOIN products p ON ti.product_id = p.id JOIN categories c ON p.category_id = c.id WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf} AND upper(COALESCE(p.sku, '')) != ? AND (ti.serial_number IS NULL OR ti.serial_number = '') GROUP BY c.id ORDER BY revenue DESC`, args: [s, e, ...bp, SERIAL_NUMBER_SKU] });
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
    // t.branch_id IS NULL first: SQL's `NULL NOT IN (...)` is NULL (not true),
    // so without this a branchless transaction (e.g. an online order with no
    // branch assigned) silently dropped out of every stat below instead of
    // counting as "not a warehouse sale".
    const warehouseExclude = `AND (t.branch_id IS NULL OR t.branch_id NOT IN (SELECT id FROM branches WHERE is_warehouse = 1))`;
    // A salesperson's dashboard shows only their own sales, not the store's —
    // see is_salesperson migration note in database.js.
    const mine = !!req.employee?.is_salesperson;
    // "Mine" = sales credited to them (see ticketSalesperson in routes/transactions.js).
    const ef = mine ? ' AND COALESCE(t.salesperson_id, t.created_by, t.employee_id) = ?' : '';
    const ep = mine ? [req.employee.id] : [];

    // Today, this month and the 7-day chart are on the store clock, so they
    // agree with the salesperson target meters.
    await refreshStoreTz();
    const storeOffset = storeOffsetModifier();
    const storeDayToday = storeToday();
    const { rows: [todayStats] } = await db.execute({ sql: `SELECT COUNT(*) as transactions, COALESCE(SUM(total),0) as sales FROM transactions t WHERE t.status='completed' AND date(t.created_at, ?) = date(?) ${warehouseExclude}${bf}${ef}`, args: [storeOffset, storeDayToday, ...bp, ...ep] });
    const { rows: [monthStats] } = await db.execute({ sql: `SELECT COUNT(*) as transactions, COALESCE(SUM(total),0) as sales FROM transactions t WHERE t.status='completed' AND date(t.created_at, ?) >= date(?) ${warehouseExclude}${bf}${ef}`, args: [storeOffset, `${storeDayToday.slice(0, 7)}-01`, ...bp, ...ep] });
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
    const { rows: recentTx } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name FROM transactions t LEFT JOIN customers c ON t.customer_id = c.id WHERE 1=1 ${warehouseExclude}${bf}${ef} ORDER BY t.created_at DESC LIMIT 5`, args: [...bp, ...ep] });
    const { rows: last7Days } = await db.execute({ sql: `SELECT date(t.created_at, ?) as date, COALESCE(SUM(t.total),0) as sales, COUNT(*) as transactions FROM transactions t WHERE t.status='completed' AND date(t.created_at, ?) >= date(?, '-6 days') ${warehouseExclude}${bf}${ef} GROUP BY date(t.created_at, ?) ORDER BY date`, args: [storeOffset, storeOffset, storeDayToday, ...bp, ...ep, storeOffset] });

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

    const { rows: [summary] } = await db.execute({ sql: `SELECT COUNT(*) as payment_count, COALESCE(SUM(amount), 0) as total_collected FROM account_payments p WHERE p.payment_method NOT IN ('credit_note', 'tax_exempt', 'contra') AND date(p.created_at) BETWEEN date(?) AND date(?)${bf}`, args: [s, e, ...bp] });
    const { rows: byDay } = await db.execute({ sql: `SELECT date(p.created_at) as date, COUNT(*) as payments, COALESCE(SUM(p.amount), 0) as collected FROM account_payments p WHERE p.payment_method NOT IN ('credit_note', 'tax_exempt', 'contra') AND date(p.created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY date(p.created_at) ORDER BY date`, args: [s, e, ...bp] });
    const { rows: byMethod } = await db.execute({ sql: `SELECT p.payment_method, COUNT(*) as count, COALESCE(SUM(p.amount), 0) as total FROM account_payments p WHERE p.payment_method NOT IN ('credit_note', 'tax_exempt', 'contra') AND date(p.created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY p.payment_method ORDER BY total DESC`, args: [s, e, ...bp] });
    const { rows: byCustomer } = await db.execute({ sql: `SELECT c.customer_number, c.first_name || ' ' || c.last_name as customer_name, COUNT(*) as payments, COALESCE(SUM(p.amount), 0) as total_paid, c.account_balance as outstanding FROM account_payments p JOIN customers c ON p.customer_id = c.id WHERE p.payment_method NOT IN ('credit_note', 'tax_exempt', 'contra') AND date(p.created_at) BETWEEN date(?) AND date(?)${bf} GROUP BY p.customer_id ORDER BY total_paid DESC`, args: [s, e, ...bp] });

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
              COALESCE(SUM(COALESCE(qi.unit_cost, 0) * qi.quantity * COALESCE(qi.rent_period, 1)), 0) as cost,
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
              COALESCE(SUM(COALESCE(qi.unit_cost, 0) * qi.quantity * COALESCE(qi.rent_period, 1)), 0) as cost
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
      sql: `SELECT cc.id as category_id, COALESCE(SUM(ti.quantity * COALESCE(ti.units_per, 1) * COALESCE(p.cost, 0)), 0) as cost
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
      sql: `SELECT COALESCE(SUM(ti.quantity * COALESCE(ti.units_per, 1) * COALESCE(p.cost, 0)), 0) as cost
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
// public/js/pos.js's checkout flow) — a card's use is recorded by
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

// Cash drawer variance trend — counted cash vs. expected cash on every
// reconciled session in range, worked out the way lib/drawerReport.js does
// for the reconciliation screen: cash sales (split-tender legs from
// transaction_payments, else the whole transaction) plus cash account
// payments, less petty cash paid out and cash refunds paid from the drawer
// (returns.drawer_session_id) — plus the opening float only for
// older reconciliations that counted it with the cash (float_returned NULL).
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
              ds.branch_id, b.name as branch_name, ds.opening_float, dr.cash_counted, dr.float_returned,
              (SELECT COALESCE(SUM(p.amount), 0) FROM drawer_payouts p WHERE p.session_id = ds.id AND p.voided_at IS NULL) as payouts,
              (SELECT COALESCE(SUM(r.total), 0) FROM returns r WHERE r.drawer_session_id = ds.id AND r.resolution = 'refund' AND r.refund_method = 'cash' AND r.status != 'cancelled') as cash_refunds,
              (
                SELECT COALESCE(SUM(amount), 0) FROM (
                  SELECT tp.amount FROM transaction_payments tp JOIN transactions t ON t.id = tp.transaction_id
                  WHERE t.drawer_session_id = ds.id AND tp.payment_method = 'cash'
                  UNION ALL
                  SELECT t.total FROM transactions t
                  WHERE t.drawer_session_id = ds.id AND t.payment_method = 'cash'
                    AND NOT EXISTS (SELECT 1 FROM transaction_payments tp2 WHERE tp2.transaction_id = t.id)
                  UNION ALL
                  SELECT ap.amount FROM account_payments ap WHERE ap.drawer_session_id = ds.id AND ap.payment_method = 'cash'
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
      const floatInCash = row.float_returned == null;
      row.expected_cash = parseFloat(((floatInCash ? row.opening_float : 0) + row.cash_sales - row.payouts - row.cash_refunds).toFixed(2));
      row.float_variance = floatInCash ? null : parseFloat((row.float_returned - row.opening_float).toFixed(2));
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
              ${oldestUnpaidSaleSql('c.id')} as oldest_unpaid_date,
              ${oldestOpenLegacySql('c.id')} as legacy_oldest_date
            FROM customers c
            WHERE c.credit_enabled = 1 AND c.active = 1 AND c.account_balance > 0
            ORDER BY c.account_balance DESC`,
      args: [],
    });
    for (const c of customers) {
      c.oldest_unpaid_date = earliestDate(c.oldest_unpaid_date, c.legacy_oldest_date);
      delete c.legacy_oldest_date;
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

// Tax collected — sized for filing: taxable sales (subtotal, less the ticket
// discount on sales where it came off before tax — discount_pre_tax, see
// lib/ticketDiscount.js) alongside tax actually collected, by day and by branch.
const TAXABLE_SQL = (t = '') => `COALESCE(SUM(${t}subtotal - CASE WHEN ${t}discount_pre_tax = 1 THEN ${t}discount_amount ELSE 0 END), 0)`;
router.get('/tax-collected', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows: [summary] } = await db.execute({
      sql: `SELECT COUNT(*) as tx_count, ${TAXABLE_SQL()} as taxable_sales, COALESCE(SUM(tax_amount), 0) as tax_collected
            FROM transactions WHERE status = 'completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });
    const { rows: byDay } = await db.execute({
      sql: `SELECT date(created_at) as date, ${TAXABLE_SQL()} as taxable_sales, COALESCE(SUM(tax_amount), 0) as tax_collected
            FROM transactions WHERE status = 'completed' AND date(created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY date(created_at) ORDER BY date`,
      args: [s, e, ...bp],
    });
    const { rows: byBranch } = await db.execute({
      sql: `SELECT t.branch_id, b.name as branch_name, ${TAXABLE_SQL('t.')} as taxable_sales, COALESCE(SUM(t.tax_amount), 0) as tax_collected
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
      sql: `SELECT COALESCE(SUM(ti.total), 0) as revenue, COALESCE(SUM(ti.quantity * COALESCE(ti.units_per, 1) * COALESCE(p.cost, 0)), 0) as cost
            FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id LEFT JOIN products p ON ti.product_id = p.id
            WHERE t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}`,
      args: [s, e, ...bp],
    });
    summary.margin = parseFloat((summary.revenue - summary.cost).toFixed(2));
    summary.margin_percent = summary.revenue > 0 ? parseFloat((summary.margin / summary.revenue * 100).toFixed(1)) : null;

    const { rows: byCategory } = await db.execute({
      sql: `SELECT c.id as category_id, COALESCE(c.name, 'Uncategorized') as category_name,
              COALESCE(SUM(ti.total), 0) as revenue, COALESCE(SUM(ti.quantity * COALESCE(ti.units_per, 1) * COALESCE(p.cost, 0)), 0) as cost
            FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
            LEFT JOIN products p ON ti.product_id = p.id LEFT JOIN categories c ON p.category_id = c.id
            WHERE t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY c.id ORDER BY revenue DESC`,
      args: [s, e, ...bp],
    });
    const { rows: byBranch } = await db.execute({
      sql: `SELECT t.branch_id, b.name as branch_name,
              COALESCE(SUM(ti.total), 0) as revenue, COALESCE(SUM(ti.quantity * COALESCE(ti.units_per, 1) * COALESCE(p.cost, 0)), 0) as cost
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

// Supplier item sales — what each supplier's items sold over a period, net
// of returns. An item belongs to the supplier set on the product, or failing
// that the supplier of the latest (non-cancelled) PO it was on; items with
// neither are grouped as "No supplier". supplier_id narrows to one supplier
// ('none' = the unattributed ones) and adds its per-item rows; period
// (day/week/month/quarter/year) buckets the trend. Units are stock units;
// cost is net units × the product's current cost, as in /gross-margin.
const SUPPLIER_PERIOD_SQL = {
  day: "date(l.at)",
  week: "date(l.at, 'weekday 0', '-6 days')", // Monday the week starts on
  month: "strftime('%Y-%m', l.at)",
  quarter: "strftime('%Y', l.at) || '-Q' || ((CAST(strftime('%m', l.at) AS INTEGER) + 2) / 3)",
  year: "strftime('%Y', l.at)",
};
router.get('/supplier-item-sales', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id, supplier_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const period = SUPPLIER_PERIOD_SQL[req.query.period] ? req.query.period : 'month';
    const tbf = branch_id ? ' AND t.branch_id = ?' : '';
    const rbf = branch_id ? ' AND r.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    // Sale and return lines in range, each tagged with its item's supplier.
    const base = `WITH lines AS (
        SELECT ti.product_id, t.created_at AS at, ti.quantity * COALESCE(ti.units_per, 1) AS units, ti.total AS sales, 0 AS ret_units, 0 AS returns
        FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.status = 'completed' AND ti.product_id IS NOT NULL AND date(t.created_at) BETWEEN date(?) AND date(?)${tbf}
        UNION ALL
        SELECT ri.product_id, r.created_at, 0, 0, ri.quantity * COALESCE(ti.units_per, 1), ri.total
        FROM return_items ri JOIN returns r ON r.id = ri.return_id LEFT JOIN transaction_items ti ON ti.id = ri.transaction_item_id
        WHERE r.status != 'cancelled' AND ri.product_id IS NOT NULL AND date(r.created_at) BETWEEN date(?) AND date(?)${rbf}
      ),
      attr AS (
        SELECT p.id AS product_id, COALESCE(p.supplier_id, (
          SELECT po.supplier_id FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
          WHERE poi.product_id = p.id AND po.status != 'cancelled' AND po.supplier_id IS NOT NULL
          ORDER BY po.created_at DESC, po.id DESC LIMIT 1)) AS supplier_id
        FROM products p WHERE p.id IN (SELECT DISTINCT product_id FROM lines)
      ),
      tagged AS (
        SELECT l.*, a.supplier_id, p.cost FROM lines l JOIN attr a ON a.product_id = l.product_id JOIN products p ON p.id = l.product_id
      )`;
    const args = [s, e, ...bp, s, e, ...bp];
    const sums = `COALESCE(SUM(l.units), 0) AS units, COALESCE(SUM(l.ret_units), 0) AS ret_units,
      COALESCE(SUM(l.sales), 0) AS sales, COALESCE(SUM(l.returns), 0) AS returns,
      COALESCE(SUM((l.units - l.ret_units) * COALESCE(l.cost, 0)), 0) AS cost`;
    let sf = '', sp = [];
    if (supplier_id === 'none') sf = ' WHERE l.supplier_id IS NULL';
    else if (supplier_id) { sf = ' WHERE l.supplier_id = ?'; sp = [Number(supplier_id)]; }

    const finish = r => {
      r.sales = parseFloat(Number(r.sales).toFixed(2));
      r.returns = parseFloat(Number(r.returns).toFixed(2));
      r.net_units = Math.round((r.units - r.ret_units) * 1000) / 1000;
      r.net_sales = parseFloat((r.sales - r.returns).toFixed(2));
      r.cost = parseFloat(Number(r.cost).toFixed(2));
      r.margin = parseFloat((r.net_sales - r.cost).toFixed(2));
      r.margin_percent = r.net_sales > 0 ? parseFloat((r.margin / r.net_sales * 100).toFixed(1)) : null;
      return r;
    };

    const { rows: bySupplier } = await db.execute({
      sql: `${base} SELECT l.supplier_id, COALESCE(sup.name, 'No supplier') AS supplier_name, COUNT(DISTINCT l.product_id) AS items, ${sums}
            FROM tagged l LEFT JOIN suppliers sup ON sup.id = l.supplier_id
            GROUP BY l.supplier_id ORDER BY (SUM(l.sales) - SUM(l.returns)) DESC`,
      args,
    });
    const { rows: byPeriod } = await db.execute({
      sql: `${base} SELECT ${SUPPLIER_PERIOD_SQL[period]} AS period, ${sums}
            FROM tagged l${sf} GROUP BY period ORDER BY period`,
      args: [...args, ...sp],
    });
    let items = [], itemPeriods = [];
    if (supplier_id) {
      ({ rows: items } = await db.execute({
        sql: `${base} SELECT l.product_id, p.sku, p.name AS product_name, ${sums}
              FROM tagged l JOIN products p ON p.id = l.product_id${sf}
              GROUP BY l.product_id ORDER BY (SUM(l.sales) - SUM(l.returns)) DESC`,
        args: [...args, ...sp],
      }));
      // Net units per item per period — the item × time-frame grid.
      ({ rows: itemPeriods } = await db.execute({
        sql: `${base} SELECT l.product_id, ${SUPPLIER_PERIOD_SQL[period]} AS period,
                ROUND(SUM(l.units - l.ret_units), 3) AS net_units, ROUND(SUM(l.sales - l.returns), 2) AS net_sales
              FROM tagged l${sf} GROUP BY l.product_id, period`,
        args: [...args, ...sp],
      }));
    }

    const scope = supplier_id ? bySupplier.filter(r => supplier_id === 'none' ? r.supplier_id == null : String(r.supplier_id) === String(supplier_id)) : bySupplier;
    const summary = finish(scope.reduce((t, r) => {
      for (const k of ['units', 'ret_units', 'sales', 'returns', 'cost']) t[k] += Number(r[k]) || 0;
      t.items += Number(r.items) || 0;
      return t;
    }, { items: 0, units: 0, ret_units: 0, sales: 0, returns: 0, cost: 0 }));

    res.json({ start: s, end: e, period, summary, bySupplier: bySupplier.map(finish), byPeriod: byPeriod.map(finish), items: items.map(finish), itemPeriods });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Items sold — per-item units and sales over a period, net of returns, for
// the Inventory Reports screen. Same sale/return line basis as
// /supplier-item-sales (stock units; returns counted on the day processed;
// cost = net units × current cost). type 'stock' (default) keeps to the
// Retail Inventory items — no services, rentals or non-inventory — 'all'
// takes every product. on_hand is the branch's stock when branch_id is set,
// otherwise the global stock_qty. Reachable from Reports or Inventory.
router.get('/items-sold', requireAnyPermission('reports', 'inventory'), async (req, res) => {
  try {
    const { start, end, branch_id, category_id, brand, q } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const tbf = branch_id ? ' AND t.branch_id = ?' : '';
    const rbf = branch_id ? ' AND r.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    let pf = '';
    const pp = [];
    if (req.query.type !== 'all') pf += ' AND COALESCE(p.is_service, 0) = 0 AND COALESCE(p.is_rental, 0) = 0 AND COALESCE(p.is_non_inventory, 0) = 0';
    if (category_id === 'none') pf += ' AND p.category_id IS NULL';
    else if (category_id) { pf += ' AND p.category_id = ?'; pp.push(Number(category_id)); }
    if (brand) { pf += ' AND p.brand = ?'; pp.push(brand); }
    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      pf += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
      pp.push(like, like, like);
    }
    const onHand = branch_id
      ? '(SELECT bi.stock_qty FROM branch_inventory bi WHERE bi.product_id = p.id AND bi.branch_id = ?)'
      : 'p.stock_qty';

    const { rows } = await db.execute({
      sql: `WITH lines AS (
          SELECT ti.product_id, t.id AS tx_id, ti.quantity * COALESCE(ti.units_per, 1) AS units, ti.total AS sales, 0 AS ret_units, 0 AS returns
          FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
          WHERE t.status = 'completed' AND ti.product_id IS NOT NULL AND date(t.created_at) BETWEEN date(?) AND date(?)${tbf}
          UNION ALL
          SELECT ri.product_id, NULL, 0, 0, ri.quantity * COALESCE(ti.units_per, 1), ri.total
          FROM return_items ri JOIN returns r ON r.id = ri.return_id LEFT JOIN transaction_items ti ON ti.id = ri.transaction_item_id
          WHERE r.status != 'cancelled' AND ri.product_id IS NOT NULL AND date(r.created_at) BETWEEN date(?) AND date(?)${rbf}
        )
        SELECT p.id AS product_id, p.sku, p.name AS product_name, COALESCE(c.name, 'Uncategorized') AS category_name, p.brand,
          COUNT(DISTINCT l.tx_id) AS sales_count,
          COALESCE(SUM(l.units), 0) AS units, COALESCE(SUM(l.ret_units), 0) AS ret_units,
          COALESCE(SUM(l.sales), 0) AS sales, COALESCE(SUM(l.returns), 0) AS returns,
          COALESCE(SUM((l.units - l.ret_units) * COALESCE(p.cost, 0)), 0) AS cost,
          ${onHand} AS on_hand
        FROM lines l JOIN products p ON p.id = l.product_id LEFT JOIN categories c ON c.id = p.category_id
        WHERE upper(COALESCE(p.sku, '')) != ?${pf}
        GROUP BY p.id
        ORDER BY SUM(l.units - l.ret_units) DESC, SUM(l.sales - l.returns) DESC`,
      // The $0 SN item only carries serial numbers — never an item sold,
      // even with type=all.
      args: [s, e, ...bp, s, e, ...bp, ...bp, SERIAL_NUMBER_SKU, ...pp],
    });

    const items = rows.map(r => {
      const net_units = Math.round((r.units - r.ret_units) * 1000) / 1000;
      const net_sales = parseFloat((r.sales - r.returns).toFixed(2));
      const cost = parseFloat(Number(r.cost).toFixed(2));
      const margin = parseFloat((net_sales - cost).toFixed(2));
      return {
        ...r,
        sales: parseFloat(Number(r.sales).toFixed(2)),
        returns: parseFloat(Number(r.returns).toFixed(2)),
        net_units, net_sales, cost, margin,
        margin_percent: net_sales > 0 ? parseFloat((margin / net_sales * 100).toFixed(1)) : null,
        avg_price: r.units > 0 ? parseFloat((r.sales / r.units).toFixed(2)) : null,
        on_hand: r.on_hand == null ? null : Number(r.on_hand),
      };
    });
    const summary = items.reduce((t, r) => {
      for (const k of ['units', 'ret_units', 'net_units', 'sales', 'returns', 'net_sales', 'cost', 'margin']) t[k] += Number(r[k]) || 0;
      return t;
    }, { items: items.length, units: 0, ret_units: 0, net_units: 0, sales: 0, returns: 0, net_sales: 0, cost: 0, margin: 0 });
    for (const k of ['sales', 'returns', 'net_sales', 'cost', 'margin']) summary[k] = parseFloat(summary[k].toFixed(2));
    for (const k of ['units', 'ret_units', 'net_units']) summary[k] = Math.round(summary[k] * 1000) / 1000;
    summary.margin_percent = summary.net_sales > 0 ? parseFloat((summary.margin / summary.net_sales * 100).toFixed(1)) : null;

    res.json({ start: s, end: e, summary, items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Items returned — for the Inventory Reports screen: each item returned in the
// period (by return date; cancelled returns left out), how many returns it was
// on, units returned (stock units, like Items Sold), the value returned (line
// totals before tax, after any discount — what the return credited), how many
// customers returned it, units sold in the same period and the return rate;
// with, per item, each customer who returned it (count, units, value, last
// return date and reason). type 'stock' (default) keeps to Retail Inventory
// items; resolution refund|credit_note|replacement narrows it; branch_id is
// the branch the return was processed at.
router.get('/items-returned', requireAnyPermission('reports', 'inventory'), async (req, res) => {
  try {
    const { start, end, branch_id, category_id, brand, q, resolution } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    let rf = " AND r.status != 'cancelled'";
    const rp = [];
    if (branch_id) { rf += ' AND r.branch_id = ?'; rp.push(Number(branch_id)); }
    if (['refund', 'credit_note', 'replacement'].includes(resolution)) { rf += ' AND r.resolution = ?'; rp.push(resolution); }
    let pf = '';
    const pp = [];
    if (req.query.type !== 'all') pf += ' AND COALESCE(p.is_service, 0) = 0 AND COALESCE(p.is_rental, 0) = 0 AND COALESCE(p.is_non_inventory, 0) = 0';
    if (category_id === 'none') pf += ' AND p.category_id IS NULL';
    else if (category_id) { pf += ' AND p.category_id = ?'; pp.push(Number(category_id)); }
    if (brand) { pf += ' AND p.brand = ?'; pp.push(brand); }
    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      pf += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
      pp.push(like, like, like);
    }
    const { rows: lines } = await db.execute({
      sql: `SELECT ri.product_id, r.id AS return_id, r.customer_id, r.created_at, r.notes,
              ri.quantity * COALESCE(ti.units_per, 1) AS units, ri.total AS value,
              c.first_name || ' ' || c.last_name AS customer_name, c.business_name, c.customer_number, c.phone AS customer_phone
            FROM return_items ri JOIN returns r ON r.id = ri.return_id
            JOIN products p ON p.id = ri.product_id
            LEFT JOIN transaction_items ti ON ti.id = ri.transaction_item_id
            LEFT JOIN customers c ON c.id = r.customer_id
            WHERE date(r.created_at) BETWEEN date(?) AND date(?)${rf}
              AND upper(COALESCE(p.sku, '')) != ?${pf}
            ORDER BY r.created_at`,
      args: [s, e, ...rp, SERIAL_NUMBER_SKU, ...pp],
    });
    const ids = [...new Set(lines.map(l => l.product_id))];
    const products = new Map();
    const sold = new Map();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const { rows: prows } = await db.execute({ sql: `SELECT p.id, p.sku, p.name, p.brand, COALESCE(c.name, 'Uncategorized') AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id IN (${ph})`, args: ids });
      for (const r of prows) products.set(r.id, r);
      const { rows: srows } = await db.execute({
        sql: `SELECT ti.product_id, SUM(ti.quantity * COALESCE(ti.units_per, 1)) AS units FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
              WHERE t.status = 'completed' AND ti.product_id IN (${ph}) AND date(t.created_at) BETWEEN date(?) AND date(?)${branch_id ? ' AND t.branch_id = ?' : ''}
              GROUP BY ti.product_id`,
        args: [...ids, s, e, ...(branch_id ? [Number(branch_id)] : [])],
      });
      for (const r of srows) sold.set(r.product_id, Number(r.units) || 0);
    }
    const r3 = n => Math.round(n * 1000) / 1000, r2 = n => parseFloat(n.toFixed(2));
    const byItem = new Map();
    for (const l of lines) {
      let it = byItem.get(l.product_id);
      if (!it) {
        const p = products.get(l.product_id) || {};
        it = { product_id: l.product_id, sku: p.sku, product_name: p.name, category_name: p.category_name, brand: p.brand, returns: new Set(), units: 0, value: 0, customers: new Map() };
        byItem.set(l.product_id, it);
      }
      it.returns.add(l.return_id); it.units += Number(l.units) || 0; it.value += Number(l.value) || 0;
      const key = l.customer_id || 'walkin';
      let c = it.customers.get(key);
      if (!c) { c = { customer_id: l.customer_id || null, customer_name: l.customer_id ? l.customer_name : 'Walk-in', business_name: l.business_name || null, customer_number: l.customer_number || null, customer_phone: l.customer_phone || null, returns: new Set(), units: 0, value: 0 }; it.customers.set(key, c); }
      c.returns.add(l.return_id); c.units += Number(l.units) || 0; c.value += Number(l.value) || 0;
      c.last_returned_at = l.created_at; c.last_reason = l.notes || null;
    }
    const items = [...byItem.values()].map(it => {
      const soldUnits = sold.get(it.product_id) || 0;
      const customers = [...it.customers.values()].map(c => ({ ...c, returns: c.returns.size, units: r3(c.units), value: r2(c.value) }))
        .sort((a, b) => b.returns - a.returns || b.value - a.value);
      return {
        product_id: it.product_id, sku: it.sku, product_name: it.product_name, category_name: it.category_name, brand: it.brand,
        returns: it.returns.size, units: r3(it.units), value: r2(it.value), customer_count: customers.length,
        units_sold: r3(soldUnits), return_rate: soldUnits > 0 ? parseFloat((it.units / soldUnits * 100).toFixed(1)) : null,
        customers,
      };
    });
    const allReturns = new Set(lines.map(l => l.return_id));
    const allCustomers = new Set(lines.map(l => l.customer_id || 'walkin'));
    const summary = {
      items: items.length, returns: allReturns.size, customers: allCustomers.size,
      units: r3(items.reduce((t, i) => t + i.units, 0)), value: r2(items.reduce((t, i) => t + i.value, 0)),
    };
    res.json({ start: s, end: e, summary, items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Zero and negative stock — Retail Inventory items (no services, rentals or
// non-inventory, never the SN carrier item) at or below 0 on hand, one row per
// item per location from branch_inventory; an item with no branch rows at all
// is read from its overall products.stock_qty (location null). status
// zero|negative narrows it (default both), branch_id to one location; inactive
// items only with include_inactive=1. value = on hand × current cost (so a
// negative row is negative), last_sold / last_received at that location
// (completed sales; PO receipts and receipts without a PO not reversed).
router.get('/zero-negative-stock', requireAnyPermission('reports', 'inventory'), async (req, res) => {
  try {
    const { branch_id, category_id, brand, q } = req.query;
    const status = ['zero', 'negative'].includes(req.query.status) ? req.query.status : 'all';
    const qtyCond = status === 'zero' ? '= 0' : status === 'negative' ? '< 0' : '<= 0';

    let pf = ' AND COALESCE(p.is_service, 0) = 0 AND COALESCE(p.is_rental, 0) = 0 AND COALESCE(p.is_non_inventory, 0) = 0'
      + ' AND p.merged_into_product_id IS NULL AND upper(COALESCE(p.sku, \'\')) != ?';
    const pp = [SERIAL_NUMBER_SKU];
    if (req.query.include_inactive !== '1') pf += ' AND p.active = 1';
    if (category_id === 'none') pf += ' AND p.category_id IS NULL';
    else if (category_id) { pf += ' AND p.category_id = ?'; pp.push(Number(category_id)); }
    if (brand) { pf += ' AND p.brand = ?'; pp.push(brand); }
    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      pf += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
      pp.push(like, like, like);
    }

    // Per-location rows, plus items never put at a location (overall stock).
    const located = `SELECT p.id AS product_id, bi.branch_id, bi.stock_qty AS on_hand, COALESCE(bi.min_stock, p.min_stock) AS min_stock
      FROM branch_inventory bi JOIN products p ON p.id = bi.product_id
      WHERE bi.stock_qty ${qtyCond}${branch_id ? ' AND bi.branch_id = ?' : ''}${pf}`;
    const unlocated = `SELECT p.id, NULL, p.stock_qty, p.min_stock FROM products p
      WHERE p.stock_qty ${qtyCond} AND NOT EXISTS (SELECT 1 FROM branch_inventory bi WHERE bi.product_id = p.id)${pf}`;
    const parts = branch_id ? located : `${located} UNION ALL ${unlocated}`;
    const partArgs = branch_id ? [Number(branch_id), ...pp] : [...pp, ...pp];

    const { rows } = await db.execute({
      sql: `WITH s AS (${parts})
        SELECT s.product_id, s.branch_id, b.name AS branch_name, s.on_hand, s.min_stock,
          p.sku, p.name AS product_name, p.active, COALESCE(c.name, 'Uncategorized') AS category_name, p.brand,
          COALESCE(p.cost, 0) AS cost,
          (SELECT MAX(t.created_at) FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
            WHERE ti.product_id = s.product_id AND t.status = 'completed'
              AND (s.branch_id IS NULL OR t.branch_id = s.branch_id)) AS last_sold,
          (SELECT MAX(d) FROM (
            SELECT r.received_at AS d FROM po_receipt_items ri JOIN po_receipts r ON r.id = ri.receipt_id
              WHERE ri.product_id = s.product_id AND r.status != 'reversed' AND (s.branch_id IS NULL OR r.branch_id = s.branch_id)
            UNION ALL
            SELECT r.received_at FROM direct_receipt_items ri JOIN direct_receipts r ON r.id = ri.receipt_id
              WHERE ri.product_id = s.product_id AND r.status != 'reversed' AND (s.branch_id IS NULL OR r.branch_id = s.branch_id))) AS last_received
        FROM s JOIN products p ON p.id = s.product_id
        LEFT JOIN branches b ON b.id = s.branch_id
        LEFT JOIN categories c ON c.id = p.category_id
        ORDER BY s.on_hand ASC, p.name`,
      args: partArgs,
    });

    const items = rows.map(r => {
      const on_hand = Number(r.on_hand) || 0;
      return { ...r, on_hand, cost: Number(r.cost), value: parseFloat((on_hand * Number(r.cost)).toFixed(2)) };
    });
    const neg = items.filter(r => r.on_hand < 0);
    const summary = {
      lines: items.length,
      items: new Set(items.map(r => r.product_id)).size,
      zero: items.length - neg.length,
      negative: neg.length,
      negative_units: Math.round(neg.reduce((t, r) => t + r.on_hand, 0) * 1000) / 1000,
      negative_value: parseFloat(neg.reduce((t, r) => t + r.value, 0).toFixed(2)),
    };
    res.json({ status, summary, items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rental deposit breakdown — where every deposit taken in the period ended
// up: still held on an open rental, used (consumed by rental fees / damage /
// tax at return), refunded (cash / bank transfer / original card, or still
// awaiting a recorded method), issued as a store-credit note, or netted
// against a credit-account balance. Same bucketing as GET
// /rentals/deposits/summary, but per-agreement and date-filtered. `basis`
// picks the date the range applies to: 'deposit' (when the deposit was
// taken, i.e. the checkout transaction) or 'settled' (when it was returned).
// Cancelled agreements are left out — their deposit goes back with the
// voided checkout transaction, not through this flow.
router.get('/rental-deposits', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const basis = req.query.basis === 'settled' ? 'settled' : 'deposit';
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const dateExpr = basis === 'settled' ? 'ra.returned_at' : 'COALESCE(co.created_at, ra.created_at)';
    const bf = branch_id ? ' AND ra.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows } = await db.execute({
      sql: `SELECT ra.id, ra.agreement_number, ra.status, ra.branch_id, b.name as branch_name,
              c.first_name || ' ' || c.last_name as customer_name, c.customer_number,
              ra.deposit_total, ra.credit_note_amount, ra.deposit_return_method, ra.deposit_return_reference,
              ra.settlement_transaction_id, ra.returned_at, ra.damage_fee_total,
              COALESCE(co.created_at, ra.created_at) as deposit_date,
              co.payment_method as checkout_payment_method, se.total as settlement_total
            FROM rental_agreements ra
            LEFT JOIN transactions co ON ra.checkout_transaction_id = co.id
            LEFT JOIN transactions se ON ra.settlement_transaction_id = se.id
            LEFT JOIN customers c ON ra.customer_id = c.id
            LEFT JOIN branches b ON ra.branch_id = b.id
            WHERE ra.status IN ('awaiting_issue', 'active', 'returned') AND ra.deposit_total > 0
              AND date(${dateExpr}) BETWEEN date(?) AND date(?)${bf}
            ORDER BY ${dateExpr} DESC`,
      args: [s, e, ...bp],
    });

    const r2 = n => parseFloat((n || 0).toFixed(2));
    const BUCKETS = ['collected', 'held', 'used', 'refunded_cash', 'refunded_bank_transfer', 'refunded_original_card', 'refund_pending', 'credit_note', 'applied_to_account'];
    const blank = () => Object.fromEntries(BUCKETS.map(k => [k, 0]));
    const summary = { ...blank(), agreement_count: rows.length, fee_refund: 0 };
    const counts = blank();
    const byBranch = new Map();

    const records = rows.map(a => {
      const d = blank();
      d.collected = a.deposit_total;
      let disposition, feeRefund = 0;
      if (a.status !== 'returned') {
        d.held = a.deposit_total; disposition = 'held';
      } else if (!a.settlement_transaction_id) {
        // Returned but awaiting final payment — only happens when fees
        // exceeded the deposit, so the whole deposit was consumed.
        d.used = a.deposit_total; disposition = 'used';
      } else {
        // An early return can refund unused prepaid rental fee on top of the
        // deposit, so the settlement refund may exceed the deposit. Only the
        // deposit's share (refunded first) is bucketed here; the excess is
        // reported separately as fee_refund so the buckets always sum to
        // what was collected.
        const refundDue = a.settlement_total < 0 ? r2(-a.settlement_total) : 0;
        const depositBack = r2(Math.min(refundDue, a.deposit_total));
        feeRefund = r2(refundDue - depositBack);
        d.used = r2(a.deposit_total - depositBack);
        if (depositBack <= 0) disposition = 'used';
        else if (a.checkout_payment_method === 'credit') { d.applied_to_account = depositBack; disposition = 'applied_to_account'; }
        else if (a.credit_note_amount > 0) {
          d.credit_note = r2(Math.min(a.credit_note_amount, depositBack));
          // A credit note can be issued for less than the full refund due;
          // the rest hasn't been disbursed any other way yet.
          d.refund_pending = r2(depositBack - d.credit_note);
          disposition = 'credit_note';
        } else if (['cash', 'bank_transfer', 'original_card'].includes(a.deposit_return_method)) {
          d[`refunded_${a.deposit_return_method}`] = depositBack; disposition = `refunded_${a.deposit_return_method}`;
        } else { d.refund_pending = depositBack; disposition = 'refund_pending'; }
      }
      summary.fee_refund = r2(summary.fee_refund + feeRefund);

      const key = a.branch_id || 0;
      if (!byBranch.has(key)) byBranch.set(key, { branch_id: a.branch_id, branch_name: a.branch_name, agreement_count: 0, ...blank() });
      const br = byBranch.get(key);
      br.agreement_count += 1;
      for (const k of BUCKETS) {
        summary[k] = r2(summary[k] + d[k]);
        br[k] = r2(br[k] + d[k]);
        if (d[k] > 0) counts[k] += 1;
      }
      return {
        id: a.id, agreement_number: a.agreement_number, status: a.status, branch_name: a.branch_name,
        customer_name: a.customer_name, customer_number: a.customer_number,
        deposit_date: a.deposit_date, returned_at: a.returned_at, deposit_return_reference: a.deposit_return_reference,
        disposition, ...d, fee_refund: feeRefund,
      };
    });

    summary.refunded = r2(summary.refunded_cash + summary.refunded_bank_transfer + summary.refunded_original_card);
    for (const br of byBranch.values()) br.refunded = r2(br.refunded_cash + br.refunded_bank_transfer + br.refunded_original_card);
    res.json({ basis, summary, counts, byBranch: [...byBranch.values()].sort((x, y) => y.collected - x.collected), records });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sales by branch & department. A transaction's department comes from the
// same FK links the Transactions list uses (rental_agreements checkout /
// settlement, work_orders assessment / deposit / final, a special_project
// quote's converted_to_tx); everything else is Retail. EXISTS subqueries
// instead of LEFT JOINs so one transaction can never fan out into two rows.
// Rental checkout totals include the refundable security deposit and the
// settlement subtracts it again, so it's backed out of both to report rental
// revenue rather than deposit cash flow.
const SALES_DEPARTMENTS = ['retail', 'rental', 'work_order', 'special_project'];
router.get('/sales-by-department', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows } = await db.execute({
      sql: `SELECT x.branch_id, b.name as branch_name, x.department,
              COUNT(*) as transaction_count, COALESCE(SUM(x.amount), 0) as total, COALESCE(SUM(x.tax_amount), 0) as tax
            FROM (
              SELECT t.id, t.branch_id, t.tax_amount,
                CASE
                  WHEN EXISTS (SELECT 1 FROM quotations q WHERE q.converted_to_tx = t.id AND q.quote_type = 'special_project') THEN 'special_project'
                  WHEN EXISTS (SELECT 1 FROM rental_agreements ra WHERE ra.checkout_transaction_id = t.id OR ra.settlement_transaction_id = t.id) THEN 'rental'
                  WHEN EXISTS (SELECT 1 FROM work_orders wo WHERE wo.assessment_transaction_id = t.id OR wo.deposit_transaction_id = t.id OR wo.final_transaction_id = t.id) THEN 'work_order'
                  ELSE 'retail'
                END as department,
                t.total
                  - COALESCE((SELECT SUM(ra.deposit_total) FROM rental_agreements ra WHERE ra.checkout_transaction_id = t.id), 0)
                  + COALESCE((SELECT SUM(ra.deposit_total) FROM rental_agreements ra WHERE ra.settlement_transaction_id = t.id), 0) as amount
              FROM transactions t
              WHERE t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            ) x
            LEFT JOIN branches b ON x.branch_id = b.id
            GROUP BY x.branch_id, x.department`,
      args: [s, e, ...bp],
    });

    const round = n => parseFloat((n || 0).toFixed(2));
    const emptyDepts = () => Object.fromEntries(SALES_DEPARTMENTS.map(d => [d, { total: 0, tax: 0, transaction_count: 0 }]));
    const branchMap = new Map();
    const totals = { departments: emptyDepts(), total: 0, tax: 0, transaction_count: 0 };
    for (const r of rows) {
      const key = r.branch_id ?? 'none';
      if (!branchMap.has(key)) branchMap.set(key, { branch_id: r.branch_id, branch_name: r.branch_name || 'No Branch', departments: emptyDepts(), total: 0, tax: 0, transaction_count: 0 });
      const branch = branchMap.get(key);
      for (const target of [branch, totals]) {
        const d = target.departments[r.department];
        d.total += r.total; d.tax += r.tax; d.transaction_count += r.transaction_count;
        target.total += r.total; target.tax += r.tax; target.transaction_count += r.transaction_count;
      }
    }
    const finish = obj => {
      obj.total = round(obj.total); obj.tax = round(obj.tax);
      for (const d of Object.values(obj.departments)) { d.total = round(d.total); d.tax = round(d.tax); }
      return obj;
    };
    const branches = [...branchMap.values()].map(finish).sort((a, b) => b.total - a.total);

    res.json({ start: s, end: e, departments: SALES_DEPARTMENTS, branches, totals: finish(totals) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sales by Promotion — completed sales that carried a promotion, per branch
// per promotion. A promotion is recorded on the ticket as
// transactions.promotion_name (auto-applied promos have no promotion_code,
// so this keys on the name, unlike /promotions above). Discount Card sales
// reuse promotion_name as "{type} Discount Card" and are excluded — they
// have their own report (/discount-card-utilization).
router.get('/sales-by-promotion', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows } = await db.execute({
      sql: `SELECT t.branch_id, b.name as branch_name, t.promotion_name,
              GROUP_CONCAT(DISTINCT t.promotion_code) as codes,
              COUNT(*) as transaction_count,
              COALESCE(SUM(t.discount_amount), 0) as discount, COALESCE(SUM(t.total), 0) as total
            FROM transactions t
            LEFT JOIN branches b ON t.branch_id = b.id
            WHERE t.status = 'completed' AND t.promotion_name IS NOT NULL AND t.promotion_name <> ''
              AND t.promotion_name NOT LIKE '%Discount Card%'
              AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY t.branch_id, t.promotion_name`,
      args: [s, e, ...bp],
    });
    // All completed sales per branch, so promo sales can be shown as a share.
    const { rows: allSales } = await db.execute({
      sql: `SELECT t.branch_id, COALESCE(SUM(t.total), 0) as total FROM transactions t
            WHERE t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}
            GROUP BY t.branch_id`,
      args: [s, e, ...bp],
    });

    const round = n => parseFloat((n || 0).toFixed(2));
    const allByBranch = new Map(allSales.map(r => [r.branch_id ?? 'none', r.total]));
    const blank = () => ({ transaction_count: 0, discount: 0, total: 0 });
    const add = (target, r) => { target.transaction_count += r.transaction_count; target.discount += r.discount; target.total += r.total; };
    const promoMap = new Map();
    const branchMap = new Map();
    const totals = { ...blank(), all_sales: allSales.reduce((sum, r) => sum + r.total, 0) };
    for (const r of rows) {
      if (!promoMap.has(r.promotion_name)) promoMap.set(r.promotion_name, { promotion_name: r.promotion_name, codes: new Set(), ...blank() });
      const promo = promoMap.get(r.promotion_name);
      for (const c of (r.codes || '').split(',').filter(Boolean)) promo.codes.add(c);
      const key = r.branch_id ?? 'none';
      if (!branchMap.has(key)) branchMap.set(key, { branch_id: r.branch_id, branch_name: r.branch_name || 'No Branch', all_sales: allByBranch.get(key) || 0, promotions: {}, ...blank() });
      const branch = branchMap.get(key);
      branch.promotions[r.promotion_name] = { transaction_count: r.transaction_count, discount: round(r.discount), total: round(r.total) };
      add(promo, r); add(branch, r); add(totals, r);
    }
    const finish = o => { o.discount = round(o.discount); o.total = round(o.total); if ('all_sales' in o) o.all_sales = round(o.all_sales); return o; };
    const promotions = [...promoMap.values()].map(p => finish({ ...p, codes: [...p.codes] })).sort((a, b) => b.total - a.total);
    const branches = [...branchMap.values()].map(finish).sort((a, b) => b.total - a.total);

    res.json({ start: s, end: e, promotions, branches, totals: finish(totals) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Online Sales — completed transactions that came in from an online channel
// (transactions.source: 'online' = the e-commerce API, 'woocommerce' = the
// Woo sync; same set the Online Orders screen uses). Orders whose
// fulfillment_status is 'cancelled' are listed in the fulfillment breakdown
// but kept out of the sales totals.
router.get('/online-sales', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];
    const base = `t.status = 'completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf}`;
    const online = `t.source IN ('online','woocommerce')`;
    const counted = `${online} AND COALESCE(t.fulfillment_status,'') <> 'cancelled'`;
    const args = [s, e, ...bp];
    const agg = `COUNT(*) as order_count, COALESCE(SUM(t.total), 0) as total, COALESCE(SUM(t.tax_amount), 0) as tax, COALESCE(SUM(t.discount_amount), 0) as discount`;

    const [{ rows: [totals] }, { rows: [all] }, { rows: byChannel }, { rows: byFulfillment }, { rows: byBranch }, { rows: byDay }, { rows: topProducts }] = await Promise.all([
      db.execute({ sql: `SELECT ${agg} FROM transactions t WHERE ${base} AND ${counted}`, args }),
      db.execute({ sql: `SELECT COALESCE(SUM(t.total), 0) as total FROM transactions t WHERE ${base}`, args }),
      db.execute({ sql: `SELECT t.source, ${agg} FROM transactions t WHERE ${base} AND ${counted} GROUP BY t.source ORDER BY total DESC`, args }),
      db.execute({ sql: `SELECT COALESCE(t.fulfillment_status, 'pending') as fulfillment_status, ${agg} FROM transactions t WHERE ${base} AND ${online} GROUP BY 1 ORDER BY order_count DESC`, args }),
      db.execute({ sql: `SELECT t.branch_id, b.name as branch_name, ${agg} FROM transactions t LEFT JOIN branches b ON t.branch_id = b.id WHERE ${base} AND ${counted} GROUP BY t.branch_id ORDER BY total DESC`, args }),
      db.execute({ sql: `SELECT date(t.created_at) as date, ${agg} FROM transactions t WHERE ${base} AND ${counted} GROUP BY date(t.created_at) ORDER BY date`, args }),
      db.execute({ sql: `SELECT ti.product_name, ti.sku, SUM(ti.quantity) as quantity, COUNT(DISTINCT t.id) as order_count, COALESCE(SUM(ti.total), 0) as total
            FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
            WHERE ${base} AND ${counted}
              AND (ti.serial_number IS NULL OR ti.serial_number = '') AND upper(COALESCE(ti.sku, '')) != ?
            GROUP BY COALESCE(ti.product_id, ti.sku) ORDER BY total DESC LIMIT 15`, args: [...args, SERIAL_NUMBER_SKU] }),
    ]);

    res.json({ start: s, end: e, totals: { ...totals, all_sales: all.total }, byChannel, byFulfillment, byBranch, byDay, topProducts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Hourly Sales by Day — completed sales bucketed by day of the week and hour
// of the day, in store-local time (settings.store_timezone; created_at is
// stored in UTC). `days_in_range` counts how many of each weekday the range
// holds, so the screen can show a per-day average as well as the total.
router.get('/hourly-sales', requirePermission('reports'), async (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const s = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const e = end || new Date().toISOString().slice(0, 10);
    const { rows: tzRows } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'store_timezone'", args: [] });
    let timeZone = (tzRows[0]?.value || '').trim() || 'America/Jamaica';
    try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch (err) { timeZone = 'America/Jamaica'; }
    // UTC offset of the store zone (minutes) at the middle of the range.
    const mid = new Date((new Date(`${s}T12:00:00Z`).getTime() + new Date(`${e}T12:00:00Z`).getTime()) / 2);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(mid).map(p => [p.type, p.value]));
    const offsetMin = Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - Math.floor(mid.getTime() / 60000) * 60000) / 60000);
    const toLocal = col => `datetime(${col}, '${offsetMin >= 0 ? '+' : ''}${offsetMin} minutes')`;
    const local = toLocal('t.created_at');
    const rlocal = toLocal('r.created_at');
    const bf = branch_id ? ' AND t.branch_id = ?' : '';
    const rbf = branch_id ? ' AND r.branch_id = ?' : '';
    const bp = branch_id ? [branch_id] : [];

    const { rows } = await db.execute({
      sql: `SELECT CAST(strftime('%w', ${local}) AS INTEGER) as dow, CAST(strftime('%H', ${local}) AS INTEGER) as hour,
              COUNT(*) as tickets, COALESCE(SUM(t.total), 0) as revenue
            FROM transactions t
            WHERE t.status = 'completed' AND date(${local}) BETWEEN date(?) AND date(?)${bf}
            GROUP BY dow, hour`,
      args: [s, e, ...bp],
    });
    // Returns come off the hour they were processed in. Exchange returns
    // ('replacement') are left out: the replacement sale already carries
    // the credit as a discount, so its total is net of it.
    const { rows: retRows } = await db.execute({
      sql: `SELECT CAST(strftime('%w', ${rlocal}) AS INTEGER) as dow, CAST(strftime('%H', ${rlocal}) AS INTEGER) as hour,
              COUNT(*) as count, COALESCE(SUM(r.total), 0) as amount
            FROM returns r
            WHERE r.status != 'cancelled' AND COALESCE(r.resolution, 'refund') != 'replacement'
              AND date(${rlocal}) BETWEEN date(?) AND date(?)${rbf}
            GROUP BY dow, hour`,
      args: [s, e, ...bp],
    });

    const round = n => parseFloat((n || 0).toFixed(2));
    const daysInRange = [0, 0, 0, 0, 0, 0, 0];
    for (let d = new Date(`${s}T00:00:00Z`), last = new Date(`${e}T00:00:00Z`); d <= last; d.setUTCDate(d.getUTCDate() + 1)) daysInRange[d.getUTCDay()]++;
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    // gross = sales, returns = refunds/credit notes, revenue = gross − returns.
    const blank = () => ({ tickets: 0, gross: 0, returns: 0, return_count: 0 });
    const days = names.map((name, dow) => ({ dow, name, days_in_range: daysInRange[dow], ...blank(), hours: Array.from({ length: 24 }, (_, hour) => ({ hour, ...blank() })) }));
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ...blank() }));
    const totals = blank();
    for (const r of rows) {
      for (const o of [days[r.dow].hours[r.hour], days[r.dow], hours[r.hour], totals]) { o.tickets += r.tickets; o.gross += r.revenue; }
    }
    for (const r of retRows) {
      for (const o of [days[r.dow].hours[r.hour], days[r.dow], hours[r.hour], totals]) { o.return_count += r.count; o.returns += r.amount; }
    }
    // Average per ticket is net revenue over sales tickets.
    const finish = o => {
      o.revenue = round(o.gross - o.returns); o.gross = round(o.gross); o.returns = round(o.returns);
      o.avg_ticket = o.tickets ? round(o.revenue / o.tickets) : null;
      return o;
    };
    for (const d of days) { finish(d); d.hours.forEach(finish); }
    hours.forEach(finish); finish(totals);

    let branchName = null;
    if (branch_id) {
      const { rows: [b] } = await db.execute({ sql: 'SELECT name FROM branches WHERE id = ?', args: [branch_id] });
      branchName = b?.name || null;
    }
    res.json({ start: s, end: e, time_zone: timeZone, branch_name: branchName, days, hours, totals });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Staff Purchases (Reports → Sales) — every sale on a staff account
// (customers.staff_employee_id, lib/staffPurchases.js) in a store-clock date
// range: totals, by employee (with where they stand on their limit in the
// current period), payment, branch and cashier, top items, each transaction
// and the returns made on them. Money is shown before tax (limits are
// pre-tax) with GCT and the amount paid alongside. Voided sales are listed
// but not counted.
router.get('/staff-purchases', requirePermission('reports'), async (req, res) => {
  try {
    await refreshStoreTz();
    const today = storeToday();
    const s = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : `${today.slice(0, 7)}-01`;
    const e = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : today;
    const off = storeOffsetModifier();
    const { staffStatus, staffSettings } = require('../lib/staffPurchases');
    const settings = await staffSettings(db);

    const where = [`c.staff_employee_id IS NOT NULL`, `t.status != 'hold'`, `date(t.created_at, '${off}') BETWEEN ? AND ?`];
    const args = [s, e];
    if (req.query.employee_id) { where.push('c.staff_employee_id = ?'); args.push(req.query.employee_id); }
    if (req.query.branch_id) { where.push('t.branch_id = ?'); args.push(req.query.branch_id); }
    if (req.query.tier === 'manager' || req.query.tier === 'staff') { where.push(`COALESCE(se.staff_purchase_tier, 'staff') = ?`); args.push(req.query.tier); }
    const W = where.join(' AND ');
    const FROM = `FROM transactions t JOIN customers c ON c.id = t.customer_id JOIN employees se ON se.id = c.staff_employee_id`;

    const { rows: txs } = await db.execute({
      sql: `SELECT t.id, t.transaction_number, t.created_at, date(t.created_at, '${off}') AS day, t.status, t.payment_method,
              t.subtotal, t.discount_amount, t.tax_amount, t.total, t.source_return_id, t.promotion_name,
              COALESCE(t.store_credit_applied, 0) AS store_credit, COALESCE(t.cash_back_applied, 0) AS cash_back,
              c.id AS customer_id, c.customer_number, se.id AS staff_id, se.first_name || ' ' || se.last_name AS staff_name,
              se.employee_number, COALESCE(se.staff_purchase_tier, 'staff') AS tier, se.active AS staff_active,
              t.branch_id, b.name AS branch_name, t.employee_id AS cashier_id, ce.first_name || ' ' || ce.last_name AS cashier_name,
              (SELECT COALESCE(SUM(ti.quantity * COALESCE(ti.units_per, 1)), 0) FROM transaction_items ti WHERE ti.transaction_id = t.id AND COALESCE(ti.is_comment, 0) = 0) AS units,
              (SELECT COALESCE(SUM(r.subtotal), 0) FROM returns r WHERE r.original_transaction_id = t.id AND COALESCE(r.status, '') != 'cancelled') AS returned_pretax
            ${FROM} LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN employees ce ON ce.id = t.employee_id
            WHERE ${W} ORDER BY t.created_at DESC`,
      args,
    });
    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const live = txs.filter(t => t.status !== 'voided');
    for (const t of txs) {
      const disc = t.source_return_id ? 0 : Number(t.discount_amount) || 0;
      t.gross = r2(t.subtotal);                       // before tax, before the staff discount
      t.staff_discount = r2(disc);
      t.net = r2(t.subtotal - disc);                  // before tax — what counts toward the limit
      t.paid = r2(t.total);
      t.returned_pretax = r2(t.returned_pretax);
      t.discounted = disc > 0;
    }

    // Returns processed in the range on staff-account sales (any sale date).
    const rWhere = [`c.staff_employee_id IS NOT NULL`, `COALESCE(r.status, '') != 'cancelled'`, `date(r.created_at, '${off}') BETWEEN ? AND ?`];
    const rArgs = [s, e];
    if (req.query.employee_id) { rWhere.push('c.staff_employee_id = ?'); rArgs.push(req.query.employee_id); }
    if (req.query.branch_id) { rWhere.push('r.branch_id = ?'); rArgs.push(req.query.branch_id); }
    if (req.query.tier === 'manager' || req.query.tier === 'staff') { rWhere.push(`COALESCE(se.staff_purchase_tier, 'staff') = ?`); rArgs.push(req.query.tier); }
    const { rows: returns } = await db.execute({
      sql: `SELECT r.id, r.return_number, r.created_at, r.resolution, r.subtotal, r.tax_amount, r.total, r.notes,
              t.id AS transaction_id, t.transaction_number, se.id AS staff_id, se.first_name || ' ' || se.last_name AS staff_name
            FROM returns r JOIN transactions t ON t.id = r.original_transaction_id JOIN customers c ON c.id = t.customer_id
            JOIN employees se ON se.id = c.staff_employee_id
            WHERE ${rWhere.join(' AND ')} ORDER BY r.created_at DESC`,
      args: rArgs,
    });

    const sum = (list, k) => r2(list.reduce((a, x) => a + (Number(x[k]) || 0), 0));
    const totals = {
      transactions: live.length, voided: txs.length - live.length,
      gross: sum(live, 'gross'), staff_discount: sum(live, 'staff_discount'), net: sum(live, 'net'),
      tax: sum(live, 'tax_amount'), paid: sum(live, 'paid'), units: sum(live, 'units'),
      undiscounted: live.filter(t => !t.discounted && !t.source_return_id).length,
      returns: returns.length, returns_pretax: sum(returns, 'subtotal'), returns_total: sum(returns, 'total'),
    };
    totals.net_after_returns = r2(totals.net - totals.returns_pretax);
    totals.avg_net = live.length ? r2(totals.net / live.length) : 0;
    totals.employees = new Set(live.map(t => t.staff_id)).size;

    const group = (keyFn, init) => {
      const m = new Map();
      for (const t of live) {
        const k = keyFn(t);
        if (!m.has(k)) m.set(k, { ...init(t), transactions: 0, gross: 0, staff_discount: 0, net: 0, tax: 0, paid: 0, units: 0 });
        const g = m.get(k);
        g.transactions++; g.gross += t.gross; g.staff_discount += t.staff_discount; g.net += t.net; g.tax += Number(t.tax_amount) || 0; g.paid += t.paid; g.units += Number(t.units) || 0;
      }
      return [...m.values()].map(g => ({ ...g, gross: r2(g.gross), staff_discount: r2(g.staff_discount), net: r2(g.net), tax: r2(g.tax), paid: r2(g.paid), units: r2(g.units) })).sort((a, b) => b.net - a.net);
    };

    // By employee — every staff account in the filter, even with no sales.
    const accWhere = ['c.staff_employee_id IS NOT NULL'];
    const accArgs = [];
    if (req.query.employee_id) { accWhere.push('c.staff_employee_id = ?'); accArgs.push(req.query.employee_id); }
    if (req.query.tier === 'manager' || req.query.tier === 'staff') { accWhere.push(`COALESCE(e.staff_purchase_tier, 'staff') = ?`); accArgs.push(req.query.tier); }
    const { rows: accounts } = await db.execute({
      sql: `SELECT c.id AS customer_id, c.customer_number, e.id AS staff_id, e.first_name || ' ' || e.last_name AS staff_name, e.employee_number,
              COALESCE(e.staff_purchase_tier, 'staff') AS tier, e.active AS staff_active
            FROM customers c JOIN employees e ON e.id = c.staff_employee_id WHERE ${accWhere.join(' AND ')} ORDER BY e.first_name, e.last_name`,
      args: accArgs,
    });
    const salesBy = new Map();
    for (const t of live) {
      const g = salesBy.get(t.staff_id) || { transactions: 0, gross: 0, staff_discount: 0, net: 0, tax: 0, paid: 0, units: 0 };
      g.transactions++; g.gross += t.gross; g.staff_discount += t.staff_discount; g.net += t.net; g.tax += Number(t.tax_amount) || 0; g.paid += t.paid; g.units += Number(t.units) || 0;
      salesBy.set(t.staff_id, g);
    }
    const by_employee = [];
    for (const a of accounts) {
      const g = salesBy.get(a.staff_id) || { transactions: 0, gross: 0, staff_discount: 0, net: 0, tax: 0, paid: 0, units: 0 };
      const ret = returns.filter(r => r.staff_id === a.staff_id);
      const st = await staffStatus(db, a.customer_id);
      by_employee.push({
        ...a, staff_active: !!a.staff_active,
        transactions: g.transactions, gross: r2(g.gross), staff_discount: r2(g.staff_discount), net: r2(g.net), tax: r2(g.tax), paid: r2(g.paid), units: r2(g.units),
        returns: ret.length, returns_pretax: sum(ret, 'subtotal'), net_after_returns: r2(g.net - sum(ret, 'subtotal')),
        limit: st.limit, period_label: st.period_label, period_used: st.used, period_remaining: st.remaining,
        period_used_pct: st.limit > 0 ? Math.round(st.used / st.limit * 1000) / 10 : null,
      });
    }
    by_employee.sort((a, b) => b.net - a.net || a.staff_name.localeCompare(b.staff_name));

    // Payment methods — from the tender legs, so a split counts in each.
    const ids = live.map(t => t.id);
    let by_payment = [];
    if (ids.length) {
      const { rows } = await db.execute({
        sql: `SELECT payment_method AS method, COUNT(DISTINCT transaction_id) AS transactions, COALESCE(SUM(amount), 0) AS amount
              FROM transaction_payments WHERE transaction_id IN (${ids.map(() => '?').join(',')}) GROUP BY payment_method ORDER BY amount DESC`,
        args: ids,
      });
      by_payment = rows.map(r => ({ method: r.method, transactions: r.transactions, amount: r2(r.amount) }));
    }
    const by_branch = group(t => t.branch_id || 0, t => ({ branch_id: t.branch_id, branch_name: t.branch_name || '—' }));
    const by_cashier = group(t => t.cashier_id || 0, t => ({ cashier_id: t.cashier_id, cashier_name: t.cashier_name || '—' }));
    const by_day = group(t => t.day, t => ({ day: t.day })).sort((a, b) => a.day.localeCompare(b.day));

    // Items — net of line discounts and each line's share of the staff discount, before tax.
    let top_items = [];
    if (ids.length) {
      const { rows } = await db.execute({
        sql: `SELECT ti.product_id, COALESCE(p.name, ti.product_name) AS name, COALESCE(p.sku, ti.sku) AS sku,
                SUM(ti.quantity * COALESCE(ti.units_per, 1)) AS units, COUNT(DISTINCT ti.transaction_id) AS transactions,
                SUM(ti.quantity * ti.unit_price) AS gross, SUM(ti.total - COALESCE(ti.ticket_discount, 0)) AS net,
                COUNT(DISTINCT c.staff_employee_id) AS employees
              FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id JOIN customers c ON c.id = t.customer_id
              LEFT JOIN products p ON p.id = ti.product_id
              WHERE ti.transaction_id IN (${ids.map(() => '?').join(',')}) AND COALESCE(ti.is_comment, 0) = 0
                AND (ti.serial_number IS NULL OR ti.serial_number = '') AND upper(COALESCE(p.sku, '')) != ?
              GROUP BY COALESCE(ti.product_id, ti.product_name) ORDER BY net DESC LIMIT 25`,
        args: [...ids, SERIAL_NUMBER_SKU],
      });
      top_items = rows.map(r => ({ ...r, units: r2(r.units), gross: r2(r.gross), net: r2(r.net) }));
    }

    let branchName = null;
    if (req.query.branch_id) branchName = (await db.execute({ sql: 'SELECT name FROM branches WHERE id = ?', args: [req.query.branch_id] })).rows[0]?.name || null;
    const { rows: staffList } = await db.execute({
      sql: `SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.active FROM customers c JOIN employees e ON e.id = c.staff_employee_id ORDER BY e.first_name, e.last_name`, args: [],
    });
    res.json({
      start: s, end: e, branch_name: branchName, settings, staff_accounts: staffList,
      totals, by_employee, by_payment, by_branch, by_cashier, by_day, top_items,
      transactions: txs, returns: returns.map(r => ({ ...r, subtotal: r2(r.subtotal), tax_amount: r2(r.tax_amount), total: r2(r.total) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Item Transaction History ───────────────────────────────────────────────
// Every stock movement of one item at one location (or all) over a range of
// store days: sales, returns, transfers out / in, purchase-order and direct
// receipts, adjustments and counts, layaways, shipments, shop use and work
// orders. `item` = SKU, barcode or unit barcode (exact; retail preferred), or
// `product_id`. No exact match → 404 with `matches` (name/SKU contains) to
// pick from. Rows that didn't move stock (voided sales, transfer requests not
// sent, transfers on their way in, cancelled transfers) come back with
// `counted: false` so the report can show them without adding them in.
router.get('/item-history', requireAnyPermission('reports', 'inventory'), async (req, res) => {
  try {
    await refreshStoreTz();
    const today = storeToday();
    const s = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : `${today.slice(0, 7)}-01`;
    const e = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : today;
    if (s > e) return res.status(400).json({ error: 'The start date is after the end date' });
    const off = storeOffsetModifier();
    const branchId = req.query.branch_id ? Number(req.query.branch_id) : null;

    // The item.
    let product = null;
    const pcols = `p.id, p.sku, p.barcode, p.name, p.brand, p.cost, p.price, p.is_rental, p.is_service, p.active,
      COALESCE(u.name, 'Each') AS unit_name, COALESCE(c.name, 'Uncategorized') AS category_name`;
    const pjoin = 'FROM products p LEFT JOIN units_of_measure u ON u.id = p.base_unit_id LEFT JOIN categories c ON c.id = p.category_id';
    if (req.query.product_id) {
      ({ rows: [product] } = await db.execute({ sql: `SELECT ${pcols} ${pjoin} WHERE p.id = ?`, args: [Number(req.query.product_id)] }));
    } else {
      const item = String(req.query.item || '').trim();
      if (!item) return res.status(400).json({ error: 'Enter an item number' });
      ({ rows: [product] } = await db.execute({
        sql: `SELECT ${pcols} ${pjoin}
              WHERE upper(p.sku) = upper(?) OR p.barcode = ? OR p.id IN (SELECT product_id FROM product_units WHERE barcode = ?)
              ORDER BY p.is_rental, (upper(p.sku) = upper(?)) DESC, p.active DESC LIMIT 1`,
        args: [item, item, item, item] }));
      if (!product) {
        const like = `%${item}%`;
        const { rows: matches } = await db.execute({
          sql: `SELECT p.id, p.sku, p.name, p.brand, p.is_rental, p.active FROM products p
                WHERE (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?) AND upper(COALESCE(p.sku, '')) != ?
                ORDER BY p.active DESC, p.is_rental, p.name LIMIT 25`,
          args: [like, like, like, SERIAL_NUMBER_SKU] });
        return res.status(404).json({ error: `No item with the number "${item}"`, matches });
      }
    }
    if (!product) return res.status(404).json({ error: 'Item not found', matches: [] });
    const pid = product.id;

    const inRange = col => `date(${col}, '${off}') BETWEEN ? AND ?`;
    const br = (col) => branchId ? ` AND ${col} = ?` : '';
    const bArgs = branchId ? [branchId] : [];
    const rows = [];
    const push = (list, fn) => { for (const r of list) rows.push(fn(r)); };

    // Sales (completed, credit, online…; holds left out). Voided ones are listed, not counted.
    const { rows: sales } = await db.execute({
      sql: `SELECT t.id AS transaction_id, t.transaction_number, t.created_at, t.status, t.branch_id, b.name AS branch_name,
              ti.quantity, COALESCE(ti.units_per, 1) AS units_per, ti.sell_unit, ti.unit_price, ti.total, ti.discount_amount, ti.variation_name,
              ti.transfer_qty, tfb.name AS transfer_from_name,
              COALESCE(NULLIF(c.business_name, ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) AS customer_name,
              e.first_name || ' ' || e.last_name AS employee_name
            FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
            LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN branches tfb ON tfb.id = ti.transfer_from_branch_id
            LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN employees e ON e.id = t.employee_id
            WHERE ti.product_id = ? AND COALESCE(ti.is_comment, 0) = 0 AND t.status != 'hold' AND ${inRange('t.created_at')}${br('t.branch_id')}`,
      args: [pid, s, e, ...bArgs] });
    push(sales, r => {
      const units = Number(r.quantity) * Number(r.units_per);
      const voided = r.status === 'voided';
      const notes = [];
      if (r.variation_name) notes.push(r.variation_name);
      if (r.sell_unit && Number(r.units_per) !== 1) notes.push(`${r.quantity} × ${r.sell_unit}`);
      if (Number(r.discount_amount) > 0) notes.push(`discount ${Number(r.discount_amount).toFixed(2)}`);
      if (Number(r.transfer_qty) > 0) notes.push(`${r.transfer_qty} to come by transfer from ${r.transfer_from_name || 'another branch'}`);
      return { date: r.created_at, type: 'sale', label: voided ? 'Sale (voided)' : 'Sale', branch_id: r.branch_id, branch_name: r.branch_name,
        reference: r.transaction_number, link: { kind: 'transaction', id: r.transaction_id },
        party: r.customer_name || 'Walk-in', by: r.employee_name, qty: -units, counted: !voided,
        unit_price: Number(r.units_per) ? Number(r.unit_price) / Number(r.units_per) : Number(r.unit_price), value: Number(r.total), notes: notes.join(' · '), status: r.status };
    });

    // Returns (restocked where processed).
    const { rows: rets } = await db.execute({
      sql: `SELECT r.id AS return_id, r.return_number, r.created_at, r.resolution, r.goods_condition, r.branch_id, b.name AS branch_name,
              ri.quantity, COALESCE(ti.units_per, 1) AS units_per, ri.total, t.transaction_number, t.id AS transaction_id, r.notes,
              COALESCE(NULLIF(c.business_name, ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) AS customer_name,
              e.first_name || ' ' || e.last_name AS employee_name
            FROM return_items ri JOIN returns r ON r.id = ri.return_id
            LEFT JOIN transaction_items ti ON ti.id = ri.transaction_item_id LEFT JOIN transactions t ON t.id = r.original_transaction_id
            LEFT JOIN branches b ON b.id = r.branch_id LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN employees e ON e.id = r.employee_id
            WHERE ri.product_id = ? AND COALESCE(r.status, '') != 'cancelled' AND ${inRange('r.created_at')}${br('r.branch_id')}`,
      args: [pid, s, e, ...bArgs] });
    const resLabel = { refund: 'refund', credit_note: 'credit note', replacement: 'exchange' };
    push(rets, r => {
      const units = Number(r.quantity) * Number(r.units_per);
      return { date: r.created_at, type: 'return', label: 'Return', branch_id: r.branch_id, branch_name: r.branch_name,
        reference: r.return_number, link: r.transaction_id ? { kind: 'transaction', id: r.transaction_id } : null,
        party: r.customer_name || 'Walk-in', by: r.employee_name, qty: units, counted: true, unit_price: units ? Number(r.total) / units : null, value: Number(r.total),
        notes: [`of ${r.transaction_number || 'sale'}`, resLabel[r.resolution] || r.resolution, r.goods_condition === 'damaged' ? 'damaged' : null, r.notes].filter(Boolean).join(' · ') };
    });

    // Transfers out — stock leaves the sender when the request is sent (older
    // transfers, at creation). Requests not sent yet and cancelled transfers are listed, not counted.
    const { rows: tout } = await db.execute({
      sql: `SELECT t.id, t.transfer_number, t.status, t.is_quick, t.created_at, t.sent_at, t.from_branch_id, fb.name AS from_name, tb.name AS to_name,
              ti.quantity_requested, ti.quantity_asked, ti.quantity_received, st.transaction_number AS sale_number,
              COALESCE(se.first_name || ' ' || se.last_name, re.first_name || ' ' || re.last_name) AS by_name
            FROM branch_transfer_items ti JOIN branch_transfers t ON t.id = ti.transfer_id
            LEFT JOIN branches fb ON fb.id = t.from_branch_id LEFT JOIN branches tb ON tb.id = t.to_branch_id
            LEFT JOIN employees se ON se.id = t.sent_by LEFT JOIN employees re ON re.id = t.employee_id
            LEFT JOIN transactions st ON st.id = t.transaction_id
            WHERE ti.product_id = ? AND ${inRange('COALESCE(t.sent_at, t.created_at)')}${br('t.from_branch_id')}`,
      args: [pid, s, e, ...bArgs] });
    const tStatus = { requested: 'requested, not sent', pending: 'sent, awaiting pickup', in_transit: 'in transit', received: 'received', partial: 'part received', cancelled: 'cancelled' };
    push(tout, r => {
      const requested = r.status === 'requested', cancelled = r.status === 'cancelled';
      const qty = requested ? Number(r.quantity_asked ?? r.quantity_requested) : Number(r.quantity_requested);
      return { date: r.sent_at || r.created_at, type: 'transfer_out', label: r.is_quick ? 'Quick transfer out' : requested ? 'Transfer requested' : 'Transfer out',
        branch_id: r.from_branch_id, branch_name: r.from_name, reference: r.transfer_number, link: { kind: 'transfer', id: r.id },
        party: `To ${r.to_name || '—'}`, by: r.by_name, qty: -qty, counted: !requested && !cancelled,
        notes: [tStatus[r.status] || r.status, r.sale_number ? `for sale ${r.sale_number}` : null,
          !requested && r.quantity_asked != null && Number(r.quantity_asked) !== Number(r.quantity_requested) ? `asked ${r.quantity_asked}` : null].filter(Boolean).join(' · '), status: r.status };
    });

    // Transfers in — each delivery received (quick transfers log one too).
    const { rows: tin } = await db.execute({
      sql: `SELECT t.id, t.transfer_number, t.is_quick, t.to_branch_id, fb.name AS from_name, tb.name AS to_name, rc.received_at, ri.quantity,
              rb.first_name || ' ' || rb.last_name AS by_name, COALESCE(dl.first_name || ' ' || dl.last_name, rc.delivered_by_name) AS delivered_by
            FROM branch_transfer_receipt_items ri JOIN branch_transfer_receipts rc ON rc.id = ri.receipt_id
            JOIN branch_transfer_items ti ON ti.id = ri.transfer_item_id JOIN branch_transfers t ON t.id = rc.transfer_id
            LEFT JOIN branches fb ON fb.id = t.from_branch_id LEFT JOIN branches tb ON tb.id = t.to_branch_id
            LEFT JOIN employees rb ON rb.id = rc.received_by LEFT JOIN employees dl ON dl.id = rc.delivered_by_id
            WHERE ti.product_id = ? AND ri.quantity > 0 AND ${inRange('rc.received_at')}${br('t.to_branch_id')}`,
      args: [pid, s, e, ...bArgs] });
    push(tin, r => ({ date: r.received_at, type: 'transfer_in', label: r.is_quick ? 'Quick transfer in' : 'Transfer in', branch_id: r.to_branch_id, branch_name: r.to_name,
      reference: r.transfer_number, link: { kind: 'transfer', id: r.id }, party: `From ${r.from_name || '—'}`, by: r.by_name, qty: Number(r.quantity), counted: true,
      notes: r.delivered_by && !r.is_quick ? `delivered by ${r.delivered_by}` : '' }));
    // Older transfers received before deliveries were logged.
    const { rows: tinOld } = await db.execute({
      sql: `SELECT t.id, t.transfer_number, t.to_branch_id, fb.name AS from_name, tb.name AS to_name, t.received_at, ti.quantity_received
            FROM branch_transfer_items ti JOIN branch_transfers t ON t.id = ti.transfer_id
            LEFT JOIN branches fb ON fb.id = t.from_branch_id LEFT JOIN branches tb ON tb.id = t.to_branch_id
            WHERE ti.product_id = ? AND ti.quantity_received > 0 AND t.received_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM branch_transfer_receipts rc WHERE rc.transfer_id = t.id)
              AND ${inRange('t.received_at')}${br('t.to_branch_id')}`,
      args: [pid, s, e, ...bArgs] });
    push(tinOld, r => ({ date: r.received_at, type: 'transfer_in', label: 'Transfer in', branch_id: r.to_branch_id, branch_name: r.to_name,
      reference: r.transfer_number, link: { kind: 'transfer', id: r.id }, party: `From ${r.from_name || '—'}`, by: null, qty: Number(r.quantity_received), counted: true, notes: '' }));
    // On the way in (sent, not all received yet) — listed by the date sent, not counted.
    const { rows: incoming } = await db.execute({
      sql: `SELECT t.id, t.transfer_number, t.status, t.sent_at, t.created_at, t.to_branch_id, fb.name AS from_name, tb.name AS to_name,
              ti.quantity_requested - COALESCE(ti.quantity_received, 0) AS due
            FROM branch_transfer_items ti JOIN branch_transfers t ON t.id = ti.transfer_id
            LEFT JOIN branches fb ON fb.id = t.from_branch_id LEFT JOIN branches tb ON tb.id = t.to_branch_id
            WHERE ti.product_id = ? AND t.status IN ('pending', 'in_transit', 'partial') AND ti.quantity_requested - COALESCE(ti.quantity_received, 0) > 0
              AND ${inRange('COALESCE(t.sent_at, t.created_at)')}${br('t.to_branch_id')}`,
      args: [pid, s, e, ...bArgs] });
    push(incoming, r => ({ date: r.sent_at || r.created_at, type: 'transfer_incoming', label: 'Transfer on its way in', branch_id: r.to_branch_id, branch_name: r.to_name,
      reference: r.transfer_number, link: { kind: 'transfer', id: r.id }, party: `From ${r.from_name || '—'}`, by: null, qty: Number(r.due), counted: false,
      notes: `${tStatus[r.status] || r.status} — not received yet`, status: r.status }));

    // Purchase-order receipts (a reversal is its own stock_movements row below).
    const { rows: poRec } = await db.execute({
      sql: `SELECT r.receipt_number, r.received_at, r.branch_id, b.name AS branch_name, ri.stock_units, ri.quantity, ri.new_cost, po.po_number, po.id AS po_id,
              s.name AS supplier_name, r.vendor_invoice_number, e.first_name || ' ' || e.last_name AS by_name
            FROM po_receipt_items ri JOIN po_receipts r ON r.id = ri.receipt_id JOIN purchase_orders po ON po.id = r.po_id
            LEFT JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN branches b ON b.id = r.branch_id LEFT JOIN employees e ON e.id = r.received_by
            WHERE ri.product_id = ? AND ri.stock_units > 0 AND ${inRange('r.received_at')}${br('r.branch_id')}`,
      args: [pid, s, e, ...bArgs] });
    push(poRec, r => ({ date: r.received_at, type: 'received', label: 'Received (PO)', branch_id: r.branch_id, branch_name: r.branch_name,
      reference: r.receipt_number, link: { kind: 'po', id: r.po_id }, party: r.supplier_name || '', by: r.by_name, qty: Number(r.stock_units), counted: true,
      unit_price: r.new_cost != null ? Number(r.new_cost) : null, value: r.new_cost != null ? Number(r.new_cost) * Number(r.stock_units) : null,
      notes: [r.po_number, r.vendor_invoice_number ? `invoice ${r.vendor_invoice_number}` : null].filter(Boolean).join(' · ') }));

    // Logged stock movements: adjustments, cycle counts, direct receipts,
    // receipt reversals, damaged, shop use, work orders… (no branch = only on All Locations).
    const smLabel = { adjustment: 'Adjustment', received: 'Received (no PO)', receipt_reversed: 'Receipt reversed', damaged: 'Damaged',
      shop_use: 'Shop use', wo_issue: 'Issued to work order', wo_return_used: 'Work order return', merge: 'Item merge' };
    const { rows: sms } = await db.execute({
      sql: `SELECT sm.created_at, sm.type, sm.quantity_change, sm.reference, sm.reason, sm.branch_id, b.name AS branch_name
            FROM stock_movements sm LEFT JOIN branches b ON b.id = sm.branch_id
            WHERE sm.product_id = ? AND sm.quantity_change != 0 AND ${inRange('sm.created_at')}${branchId ? ' AND sm.branch_id = ?' : ''}`,
      args: [pid, s, e, ...bArgs] });
    push(sms, r => ({ date: r.created_at, type: r.type === 'received' ? 'received' : r.type === 'adjustment' ? 'adjustment' : r.type || 'adjustment',
      label: smLabel[r.type] || (r.type ? r.type.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Adjustment'),
      branch_id: r.branch_id, branch_name: r.branch_name || 'All locations', reference: r.reference || '', link: null, party: '', by: null,
      qty: Number(r.quantity_change), counted: true, notes: r.reason || '' }));

    // Layaways — stock set aside when the plan is made, put back if it's cancelled.
    const { rows: lays } = await db.execute({
      sql: `SELECT lp.id, lp.plan_number, lp.status, lp.created_at, lp.cancelled_at, lp.branch_id, b.name AS branch_name,
              li.quantity * COALESCE(li.units_per, 1) AS units, li.unit_price, li.line_total,
              COALESCE(NULLIF(c.business_name, ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) AS customer_name,
              e.first_name || ' ' || e.last_name AS by_name
            FROM layaway_plan_items li JOIN layaway_plans lp ON lp.id = li.plan_id
            LEFT JOIN branches b ON b.id = lp.branch_id LEFT JOIN customers c ON c.id = lp.customer_id LEFT JOIN employees e ON e.id = lp.employee_id
            WHERE li.product_id = ?${br('lp.branch_id')}
              AND (${inRange('lp.created_at')} OR (lp.status = 'cancelled' AND lp.cancelled_at IS NOT NULL AND ${inRange('lp.cancelled_at')}))`,
      args: [pid, ...bArgs, s, e, s, e] });
    for (const r of lays) {
      const base = { branch_id: r.branch_id, branch_name: r.branch_name, reference: r.plan_number, link: null, party: r.customer_name || '', by: r.by_name, counted: true };
      rows.push({ ...base, date: r.created_at, type: 'layaway', label: 'Layaway', qty: -Number(r.units), value: Number(r.line_total), notes: `plan ${r.status}`, _check: 'created' });
      if (r.status === 'cancelled' && r.cancelled_at) rows.push({ ...base, date: r.cancelled_at, type: 'layaway_cancel', label: 'Layaway cancelled', qty: Number(r.units), notes: 'stock put back', _check: 'cancelled' });
    }

    // Shipments out of the location.
    const { rows: ships } = await db.execute({
      sql: `SELECT sh.shipment_number, sh.status, sh.shipped_at, sh.from_branch_id, b.name AS branch_name, si.quantity, sh.carrier, sh.tracking_number,
              COALESCE(NULLIF(c.business_name, ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) AS customer_name
            FROM shipment_items si JOIN shipments sh ON sh.id = si.shipment_id
            LEFT JOIN branches b ON b.id = sh.from_branch_id LEFT JOIN customers c ON c.id = sh.customer_id
            WHERE si.product_id = ? AND sh.shipped_at IS NOT NULL AND sh.status != 'cancelled' AND ${inRange('sh.shipped_at')}${br('sh.from_branch_id')}`,
      args: [pid, s, e, ...bArgs] });
    push(ships, r => ({ date: r.shipped_at, type: 'shipment', label: 'Shipped', branch_id: r.from_branch_id, branch_name: r.branch_name, reference: r.shipment_number, link: null,
      party: r.customer_name || '', by: null, qty: -Number(r.quantity), counted: true, notes: [r.status, r.carrier, r.tracking_number].filter(Boolean).join(' · ') }));

    // Layaway rows outside the range (made before it, cancelled in it) drop out here.
    const inDay = d => { const k = storeDay(d); return k >= s && k <= e; };
    const list = rows.filter(r => !r._check || inDay(r.date)).map(({ _check, ...r }) => r);
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // Totals by kind (counted rows only), and in / out.
    const byType = new Map();
    let unitsIn = 0, unitsOut = 0;
    for (const r of list) {
      if (!r.counted) continue;
      const k = r.label.replace(' (voided)', '');
      const t = byType.get(k) || { label: k, count: 0, units_in: 0, units_out: 0, value: 0 };
      t.count += 1;
      if (r.qty > 0) { t.units_in += r.qty; unitsIn += r.qty; } else { t.units_out += -r.qty; unitsOut += -r.qty; }
      if (r.value != null && (r.type === 'sale' || r.type === 'return')) t.value += r.type === 'return' ? -r.value : r.value;
      byType.set(k, t);
    }
    const sold = list.filter(r => r.type === 'sale' && r.counted);
    const returned = list.filter(r => r.type === 'return');
    const round = n => Math.round(n * 1000) / 1000;

    // On hand now at the location (or per location).
    const { rows: onHand } = await db.execute({
      sql: `SELECT bi.branch_id, b.name AS branch_name, bi.stock_qty FROM branch_inventory bi JOIN branches b ON b.id = bi.branch_id
            WHERE bi.product_id = ?${branchId ? ' AND bi.branch_id = ?' : ''} ORDER BY b.name`,
      args: [pid, ...bArgs] });
    let branchName = null;
    if (branchId) ({ rows: [{ name: branchName } = {}] } = await db.execute({ sql: 'SELECT name FROM branches WHERE id = ?', args: [branchId] }));

    res.json({
      start: s, end: e, branch_id: branchId, branch_name: branchName,
      product,
      on_hand: onHand,
      on_hand_total: round(onHand.reduce((n, r) => n + Number(r.stock_qty || 0), 0)),
      totals: {
        movements: list.filter(r => r.counted).length,
        units_in: round(unitsIn), units_out: round(unitsOut), net: round(unitsIn - unitsOut),
        units_sold: round(sold.reduce((n, r) => n + -r.qty, 0)),
        sales_value: Math.round(sold.reduce((n, r) => n + r.value, 0) * 100) / 100,
        sales: sold.length,
        units_returned: round(returned.reduce((n, r) => n + r.qty, 0)),
        returns_value: Math.round(returned.reduce((n, r) => n + r.value, 0) * 100) / 100,
        transfers_in: round(list.filter(r => r.type === 'transfer_in').reduce((n, r) => n + r.qty, 0)),
        transfers_out: round(list.filter(r => r.type === 'transfer_out' && r.counted).reduce((n, r) => n + -r.qty, 0)),
        received: round(list.filter(r => r.type === 'received').reduce((n, r) => n + r.qty, 0)),
        adjustments: round(list.filter(r => r.counted && !['sale', 'return', 'transfer_in', 'transfer_out', 'received', 'layaway', 'layaway_cancel', 'shipment'].includes(r.type)).reduce((n, r) => n + r.qty, 0)),
      },
      by_type: [...byType.values()].map(t => ({ ...t, units_in: round(t.units_in), units_out: round(t.units_out), value: Math.round(t.value * 100) / 100 })),
      rows: list.map(r => ({ ...r, qty: round(r.qty) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


module.exports = router;
