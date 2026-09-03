const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { syncBinQty } = require('../lib/binSync');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { requireAuth, requirePermission, can } = require('../lib/permissions');
const { getOutstandingQty } = require('../lib/rentalAvailability');
const { mergeProducts } = require('../lib/productMerge');
const { HAS_ISSUE_SQL, ISSUE_LABEL_SQL, rowsToCsv } = require('../lib/productIssues');

// CSV cells for money/quantity fields often carry currency symbols, thousands
// separators, or stray whitespace (e.g. "$15.00", "1,000") — bare parseFloat/
// parseInt chokes on the leading non-numeric char and returns NaN, which then
// silently collapses to a field's `|| 0` fallback (the value just vanishes,
// no error surfaced). Strip everything except digits/decimal point/minus
// before parsing so real amounts survive round-tripping through a CSV.
const parseNum = v => {
  if (v == null || v === '') return NaN;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  return cleaned === '' || cleaned === '-' ? NaN : parseFloat(cleaned);
};

// Product images are named after the SKU (both the upload route below and the
// folder-scan endpoint), but a SKU can contain characters that aren't safe in
// a filename or a Cloudinary public_id (seen in real data: "/", spaces) — so
// anything outside this set collapses to "_". Kept case-sensitive on purpose:
// the scan endpoint matches case-insensitively so "abc123.jpg" still finds
// SKU "ABC123", but this is what a *new* upload actually writes to disk.
const sanitizeSkuForFilename = sku => String(sku).trim().replace(/[^A-Za-z0-9_.-]/g, '_');

// POST/PUT/DELETE on /products are shared by three frontend forms (Inventory,
// Services, Rentals), but a product's *type* determines the one permission
// that should actually govern it — a Manager with general `inventory` access
// must NOT be able to edit rental items via this shared endpoint just because
// `rentals_manage_items` is unchecked for their group. `isRental`/`isService`
// reflect the row as it will exist after the write (existing DB state OR'd
// with the incoming payload, so toggling a plain item into a rental item is
// still gated by rentals_manage_items).
function requiredProductPermission(isRental, isService) {
  if (isRental) return 'rentals_manage_items';
  if (isService) return 'services';
  return 'inventory';
}

function requireProductPermission(isRental, isService) {
  return (req, res, next) => {
    if (req.apiKey) return next();
    if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
    const key = requiredProductPermission(isRental, isService);
    if (!can(req.employee.permissions, key)) {
      return res.status(403).json({ error: `Missing permission: ${key}` });
    }
    next();
  };
}

// Same idea as requireProductPermission above, but for routes keyed by
// :id with no is_rental/is_service in the body (image upload/delete) — looks
// the product's type up first so a rentals-only staffer (rentals_manage_items
// but not inventory) can manage a rental item's photo without also being
// granted the broader Inventory permission.
async function requireImagePermission(req, res, next) {
  if (req.apiKey) return next();
  if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
  try {
    const { rows: [product] } = await db.execute({ sql: 'SELECT is_rental, is_service FROM products WHERE id = ?', args: [req.params.id] });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const key = requiredProductPermission(!!product.is_rental, !!product.is_service);
    if (!can(req.employee.permissions, key)) {
      return res.status(403).json({ error: `Missing permission: ${key}` });
    }
    next();
  } catch(e) { res.status(500).json({ error: e.message }); }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// requireAuth only — the product catalog is used everywhere (POS, inventory,
// services, rentals, PO/transfer forms, ecommerce API key), not just the
// Inventory management screen.
// GET all products
router.get('/', requireAuth, async (req, res) => {
  try {
    const { search, category, brand, active, low_stock, branch_id, supplier_id, is_service, is_rental, is_accessory, is_layaway_eligible, is_non_inventory, online, for_sale } = req.query;
    const params = [];
    let sql;

    if (online === '1' || online === 'true') {
      const { rows: [setting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_sync_branch_id'", args: [] });
      const syncBranchId = setting?.value;
      const onlineParams = [];
      let stockExpr, joinClause = '';
      if (syncBranchId) {
        joinClause = ` LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ?`;
        onlineParams.push(syncBranchId);
        stockExpr = `CASE WHEN p.web_allotment IS NOT NULL THEN MIN(COALESCE(bi.stock_qty, 0), p.web_allotment) ELSE COALESCE(bi.stock_qty, 0) END`;
      } else {
        stockExpr = `CASE WHEN p.web_allotment IS NOT NULL THEN MIN(COALESCE(p.stock_qty, 0), p.web_allotment) ELSE COALESCE(p.stock_qty, 0) END`;
      }
      let onlineSql = `SELECT p.id, p.sku, p.name, p.description, p.category_id, p.price, p.cost,
        p.tax_rate, p.active, p.image_path, p.is_service, p.unit, p.is_rental,
        p.online_available, p.web_allotment, p.stock_qty as global_stock_qty,
        ${stockExpr} as stock_qty,
        c.name as category_name,
        (SELECT COUNT(*) FROM product_variations WHERE product_id = p.id AND active = 1) as has_variations
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id${joinClause}
        WHERE p.active = 1 AND p.online_available = 1`;
      if (search) { onlineSql += ` AND (p.name LIKE ? OR p.sku LIKE ?)`; onlineParams.push(`%${search}%`, `%${search}%`); }
      if (category) { onlineSql += ` AND p.category_id = ?`; onlineParams.push(category); }
      // Lets a storefront exclude (or isolate) rental items from the general
      // online feed — added because rentals carry their own rate fields this
      // slim SELECT doesn't project, so they need a dedicated online query.
      if (is_rental !== undefined) { onlineSql += ` AND p.is_rental = ?`; onlineParams.push(is_rental === '1' || is_rental === 'true' ? 1 : 0); }
      onlineSql += ` ORDER BY p.name`;
      const { rows: onlineRows } = await db.execute({ sql: onlineSql, args: onlineParams });
      return res.json(onlineRows);
    }

    // Outstanding rental qty is scoped to the requested branch when one is given
    // (matching the branch-specific stock_qty below), otherwise it's global —
    // kept in sync with lib/rentalAvailability.js's getOutstandingQty() (same
    // status list, including 'pending' — a held-for-checkout agreement
    // reserves the unit same as an active one).
    const rentalOutstandingExpr = (branchScoped) => `(SELECT COALESCE(SUM(rai.quantity - rai.quantity_returned),0)
        FROM rental_agreement_items rai JOIN rental_agreements ra ON rai.agreement_id = ra.id
        WHERE rai.product_id = p.id AND ra.status IN ('active', 'pending', 'awaiting_issue')${branchScoped ? ' AND ra.branch_id = ?' : ''}) as rental_outstanding_qty`;

    if (branch_id) {
      // price is recalculated against the branch's price_tier_percent (a
      // positive or negative % set on the branch) — every consumer of this
      // branch-scoped query (POS cart, quote line default, etc.) reads
      // `price` as-is and gets the tiered value automatically. list_price is
      // the untouched base price, kept for anywhere that wants it.
      sql = `SELECT p.id, p.sku, p.barcode, p.name, p.description, p.category_id, p.price as list_price,
        MAX(0, ROUND(p.price * (1 + COALESCE(b.price_tier_percent,0)/100.0), 2)) as price,
        p.cost, p.tax_rate, p.active, p.created_at, p.supplier_id, p.image_path, p.is_service, p.unit,
        p.is_rental, p.rental_rate_type, p.rental_rate, p.rental_deposit, p.rental_late_fee_rate, p.replacement_value,
        p.rental_classification, p.rental_weekly_rate, p.rental_monthly_rate, p.rental_hourly_rate, p.rental_allow_sale, p.is_accessory, p.is_layaway_eligible, p.is_non_inventory,
        COALESCE(bi.stock_qty, 0) as stock_qty,
        COALESCE(bi.min_stock, p.min_stock) as min_stock,
        p.stock_qty as global_stock_qty,
        c.name as category_name,
        (SELECT COUNT(*) FROM product_variations WHERE product_id = p.id AND active = 1) as has_variations,
        p.merged_into_product_id,
        (SELECT sku FROM products mp WHERE mp.id = p.merged_into_product_id) as merged_into_sku,
        ${rentalOutstandingExpr(true)}
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ?
        LEFT JOIN branches b ON b.id = ?
        WHERE 1=1`;
      params.push(branch_id); // for rentalOutstandingExpr's ra.branch_id = ?
      params.push(branch_id); // for the branch_inventory JOIN's bi.branch_id = ?
      params.push(branch_id); // for the branches JOIN's b.id = ? (price tier)
    } else {
      sql = `SELECT p.*, c.name as category_name, (SELECT COUNT(*) FROM product_variations WHERE product_id = p.id AND active = 1) as has_variations, ${rentalOutstandingExpr(false)},
        (SELECT bi.branch_id FROM branch_inventory bi WHERE bi.product_id = p.id LIMIT 1) as assigned_branch_id,
        (SELECT b.name FROM branch_inventory bi JOIN branches b ON bi.branch_id = b.id WHERE bi.product_id = p.id LIMIT 1) as assigned_branch_name,
        (SELECT sku FROM products mp WHERE mp.id = p.merged_into_product_id) as merged_into_sku
        FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE 1=1`;
    }

    if (search) {
      sql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category) { sql += ` AND p.category_id = ?`; params.push(category); }
    if (brand) { sql += ` AND p.brand = ?`; params.push(brand); }
    if (supplier_id) { sql += ` AND p.supplier_id = ?`; params.push(supplier_id); }
    if (active !== undefined) { sql += ` AND p.active = ?`; params.push(active); }
    if (is_service !== undefined) { sql += ` AND p.is_service = ?`; params.push(is_service); }
    if (is_rental !== undefined) { sql += ` AND p.is_rental = ?`; params.push(is_rental); }
    // Used by pickers that sell/quote retail items (POS, Quotations) instead
    // of the blanket is_rental=0 they used to send — lets through a rental
    // item too, but only once it's been explicitly flagged sellable on its
    // own item form. Ignored if is_rental was passed explicitly above (a
    // rental-only or exclude-rentals query means exactly that).
    else if (for_sale === '1' || for_sale === 'true') { sql += ` AND (p.is_rental = 0 OR p.rental_allow_sale = 1)`; }
    if (is_accessory !== undefined) { sql += ` AND p.is_accessory = ?`; params.push(is_accessory); }
    if (is_layaway_eligible !== undefined) { sql += ` AND p.is_layaway_eligible = ?`; params.push(is_layaway_eligible); }
    if (is_non_inventory !== undefined) { sql += ` AND p.is_non_inventory = ?`; params.push(is_non_inventory); }
    if (low_stock === 'true') {
      if (branch_id) {
        sql += ` AND COALESCE(bi.stock_qty, p.stock_qty) <= COALESCE(bi.min_stock, p.min_stock)`;
      } else {
        sql += ` AND p.stock_qty <= p.min_stock`;
      }
    }
    sql += ` ORDER BY p.name`;

    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET recent stock movements (adjustments + transfers)
router.get('/movements', requirePermission('inventory'), async (req, res) => {
  try {
    const { branch_id, limit = 50 } = req.query;
    const params = [];
    let adjSql = `SELECT sm.id, sm.created_at, p.name as product_name, p.sku, b.name as branch_name,
      sm.quantity_change, sm.type, sm.reference, sm.reason
      FROM stock_movements sm
      JOIN products p ON sm.product_id = p.id
      LEFT JOIN branches b ON sm.branch_id = b.id WHERE 1=1`;
    if (branch_id) { adjSql += ' AND sm.branch_id = ?'; params.push(branch_id); }
    adjSql += ' ORDER BY sm.created_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const trfParams = [];
    let trfSql = `SELECT ti.id, t.created_at, p.name as product_name, p.sku,
      fb.name as from_branch_name, tb.name as to_branch_name, t.transfer_number,
      ti.quantity_requested, ti.quantity_received, t.status, t.received_at
      FROM branch_transfer_items ti
      JOIN branch_transfers t ON ti.transfer_id = t.id
      JOIN products p ON ti.product_id = p.id
      JOIN branches fb ON t.from_branch_id = fb.id
      JOIN branches tb ON t.to_branch_id = tb.id WHERE 1=1`;
    if (branch_id) { trfSql += ' AND (t.from_branch_id = ? OR t.to_branch_id = ?)'; trfParams.push(branch_id, branch_id); }
    trfSql += ' ORDER BY t.created_at DESC LIMIT ?';
    trfParams.push(parseInt(limit));

    const [{ rows: adjustments }, { rows: transfers }] = await Promise.all([
      db.execute({ sql: adjSql, args: params }),
      db.execute({ sql: trfSql, args: trfParams }),
    ]);
    res.json({ adjustments, transfers });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET export filtered products as CSV
router.get('/export', requirePermission('inventory'), async (req, res) => {
  try {
    const { search, category, active, low_stock, branch_id, supplier_id, is_rental, is_service, is_non_inventory } = req.query;
    const params = [];
    let sql;

    if (branch_id) {
      sql = `SELECT p.id, p.sku, p.barcode, p.name, p.description, p.category_id, p.price, p.cost, p.tax_rate, p.active, p.created_at, p.supplier_id, p.image_path,
        COALESCE(bi.stock_qty, 0) as stock_qty,
        COALESCE(bi.min_stock, p.min_stock) as min_stock,
        p.stock_qty as global_stock_qty,
        c.name as category_name, s.name as supplier_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ?
        WHERE 1=1`;
      params.push(branch_id);
    } else {
      sql = `SELECT p.*, c.name as category_name, s.name as supplier_name
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        WHERE 1=1`;
    }

    if (search) {
      sql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category) { sql += ` AND p.category_id = ?`; params.push(category); }
    if (supplier_id) { sql += ` AND p.supplier_id = ?`; params.push(supplier_id); }
    if (active !== undefined) { sql += ` AND p.active = ?`; params.push(active); }
    if (is_rental !== undefined) { sql += ` AND p.is_rental = ?`; params.push(is_rental); }
    if (is_service !== undefined) { sql += ` AND p.is_service = ?`; params.push(is_service); }
    if (is_non_inventory !== undefined) { sql += ` AND p.is_non_inventory = ?`; params.push(is_non_inventory); }
    if (low_stock === 'true') {
      if (branch_id) {
        sql += ` AND COALESCE(bi.stock_qty, p.stock_qty) <= COALESCE(bi.min_stock, p.min_stock)`;
      } else {
        sql += ` AND p.stock_qty <= p.min_stock`;
      }
    }
    sql += ` ORDER BY p.name`;

    const { rows: products } = await db.execute({ sql, args: params });

    const escape = v => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = ['sku','barcode','name','description','category_name','price','cost','tax_rate','stock_qty','min_stock','active','supplier_name'];
    const csvRows = [headers.join(',')];
    for (const p of products) {
      csvRows.push(headers.map(h => escape(p[h])).join(','));
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="products_export_${timestamp}.csv"`);
    res.send(csvRows.join('\r\n'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET export active products with missing/questionable data — zero price
// (flagged worse when cost > 0, since that's an active product that would
// ring up free), negative stock, or no category/supplier/barcode. Same
// checks (lib/productIssues.js) used by the per-import-batch review, but
// scoped to the whole active catalog rather than one import.
router.get('/export/issues', requirePermission('inventory'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT p.id, p.sku, p.name, p.price, p.cost, p.stock_qty,
        c.name as category_name, s.name as supplier_name, p.barcode,
        ${ISSUE_LABEL_SQL} as issue
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        WHERE p.active = 1 AND ${HAS_ISSUE_SQL}
        ORDER BY p.sku`,
      args: [],
    });
    const csv = rowsToCsv(rows, ['id','sku','name','price','cost','stock_qty','category_name','supplier_name','barcode','issue']);
    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="products_missing_data_${timestamp}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET CSV template for bulk import
router.get('/export/template', requirePermission('inventory'), (req, res) => {
  const headers = ['sku','barcode','name','description','category_name','price','cost','tax_rate','stock_qty','min_stock','active','supplier_name'];
  const example = ['PROD-001','0001234567890','Example Product','Product description','Electronics','19.99','9.99','8.5','100','10','1','TechSupply Co'];
  const csv = [headers.join(','), example.join(',')].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="product_import_template.csv"');
  res.send(csv);
});

// POST import products from CSV rows
// `batch_id` (from POST /product-imports) is optional — when present, every
// row's outcome is logged to product_import_batch_items so the batch can
// later be reviewed (routes/product-imports.js GET /:id) or reversed
// (POST /:id/reverse). 'updated' rows log a full snapshot of the row *before*
// the overwrite (previous_values) since that's the only way Reverse can put
// it back — the UPDATE below doesn't otherwise keep any history.
router.post('/import', requirePermission('inventory'), async (req, res) => {
  try {
    const { rows, skip_existing, batch_id } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });

    const { rows: catRows } = await db.execute({ sql: 'SELECT id, name FROM categories', args: [] });
    const { rows: supRows } = await db.execute({ sql: 'SELECT id, name FROM suppliers', args: [] });
    const catMap = Object.fromEntries(catRows.map(c => [c.name.toLowerCase(), c.id]));
    const supMap = Object.fromEntries(supRows.map(s => [s.name.toLowerCase(), s.id]));

    let created = 0, updated = 0, skipped = 0;
    const errors = [];
    const logItem = async (sku, product_id, action, previous_values, error_message) => {
      if (!batch_id) return;
      await db.execute({
        sql: 'INSERT INTO product_import_batch_items (batch_id, product_id, sku, action, previous_values, error_message) VALUES (?,?,?,?,?,?)',
        args: [batch_id, product_id || null, sku || '', action, previous_values ? JSON.stringify(previous_values) : null, error_message || null],
      });
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const { sku, barcode, name, description, category_name, price, cost, tax_rate, stock_qty, min_stock, active, supplier_name } = row;
      if (!sku || !name) {
        const msg = `Row ${rowNum}: SKU and name are required`;
        errors.push(msg);
        await logItem(sku, null, 'error', null, msg);
        continue;
      }
      const category_id = category_name ? (catMap[category_name.toLowerCase()] ?? null) : null;
      const supplier_id = supplier_name ? (supMap[supplier_name.toLowerCase()] ?? null) : null;
      const vals = [barcode||null, name, description||null, category_id, parseNum(price)||0, parseNum(cost)||0, parseNum(tax_rate)||8.5, parseNum(stock_qty)||0, parseNum(min_stock)||5, active === '' || active == null ? 1 : (parseNum(active) ? 1 : 0), supplier_id];
      try {
        const { rows: [existing] } = await db.execute({ sql: 'SELECT * FROM products WHERE sku = ?', args: [sku] });
        if (existing && skip_existing) {
          skipped++;
          await logItem(sku, existing.id, 'skipped', null, null);
        } else if (existing) {
          await db.execute({ sql: 'UPDATE products SET barcode=?,name=?,description=?,category_id=?,price=?,cost=?,tax_rate=?,stock_qty=?,min_stock=?,active=?,supplier_id=? WHERE sku=?', args: [...vals, sku] });
          updated++;
          await logItem(sku, existing.id, 'updated', existing, null);
        } else {
          const result = await db.execute({ sql: 'INSERT INTO products (sku,barcode,name,description,category_id,price,cost,tax_rate,stock_qty,min_stock,active,supplier_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [sku, ...vals] });
          created++;
          await logItem(sku, Number(result.lastInsertRowid), 'created', null, null);
        }
      } catch (e) {
        errors.push(`Row ${rowNum} (${sku}): ${e.message}`);
        await logItem(sku, null, 'error', null, e.message);
      }
    }

    res.json({ created, updated, skipped, errors, total: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET export rental items as CSV — same shared shape/escaping as the general
// product export above, but scoped to is_rental=1 with rental-specific
// columns (rates, classification, replacement value) instead of cost/supplier.
router.get('/export/rentals', requirePermission('rentals_manage_items'), async (req, res) => {
  try {
    const { rows: rentals } = await db.execute({ sql: `SELECT p.sku, p.name, p.description, p.model_number, p.size, c.name as category_name,
      (SELECT b.name FROM branch_inventory bi JOIN branches b ON bi.branch_id = b.id WHERE bi.product_id = p.id LIMIT 1) as branch_name,
      p.stock_qty, p.min_stock, p.tax_rate, p.taxable, p.rental_classification,
      p.rental_rate as daily_rate, p.rental_weekly_rate as weekly_rate, p.rental_monthly_rate as monthly_rate, p.rental_hourly_rate as hourly_rate,
      p.replacement_value, p.is_accessory, p.active
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.is_rental = 1 ORDER BY p.name`, args: [] });

    const escape = v => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = ['sku','name','description','model_number','size','category_name','branch_name','stock_qty','min_stock','tax_rate','taxable','rental_classification','daily_rate','weekly_rate','monthly_rate','hourly_rate','replacement_value','is_accessory','active'];
    const csvRows = [headers.join(',')];
    for (const p of rentals) csvRows.push(headers.map(h => escape(p[h])).join(','));

    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="rental_items_export_${timestamp}.csv"`);
    res.send(csvRows.join('\r\n'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET CSV template for bulk rental item import
router.get('/export/rentals/template', requirePermission('rentals_manage_items'), (req, res) => {
  const headers = ['sku','name','description','model_number','size','category_name','branch_name','stock_qty','min_stock','tax_rate','taxable','rental_classification','daily_rate','weekly_rate','monthly_rate','hourly_rate','replacement_value','is_accessory','active'];
  const example = ['RENT-001','Example Drill','18V cordless drill','DW-18V','Standard','Tools','Drax Hall','5','1','8.5','1','tool','15.00','80.00','300.00','0','200.00','0','1'];
  const csv = [headers.join(','), example.join(',')].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="rental_items_import_template.csv"');
  res.send(csv);
});

// POST import rental items from CSV rows — upserts by SKU, same single-branch
// move semantics as PUT /:id (a branch_name here reassigns/moves the item's
// stock the same way changing the dropdown in the rental item form does).
router.post('/import/rentals', requirePermission('rentals_manage_items'), async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });

    const { rows: catRows } = await db.execute({ sql: 'SELECT id, name FROM categories', args: [] });
    const { rows: branchRows } = await db.execute({ sql: 'SELECT id, name FROM branches', args: [] });
    const catMap = Object.fromEntries(catRows.map(c => [c.name.toLowerCase(), c.id]));
    const branchMap = Object.fromEntries(branchRows.map(b => [b.name.toLowerCase(), b.id]));

    let created = 0, updated = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const {
        sku, name, description, model_number, size, category_name, branch_name,
        stock_qty, min_stock, tax_rate, taxable, rental_classification,
        daily_rate, weekly_rate, monthly_rate, hourly_rate,
        replacement_value, is_accessory, active,
      } = row;
      if (!sku || !name) { errors.push(`Row ${rowNum}: SKU and name are required`); continue; }
      const category_id = category_name ? (catMap[category_name.toLowerCase()] ?? null) : null;
      const branch_id = branch_name ? (branchMap[branch_name.toLowerCase()] ?? null) : null;
      if (branch_name && !branch_id) { errors.push(`Row ${rowNum} (${sku}): branch "${branch_name}" not found`); continue; }
      const classification = (rental_classification || '').toLowerCase() === 'equipment' ? 'equipment' : 'tool';
      const qty = parseNum(stock_qty) || 0;
      const minStk = parseNum(min_stock) || 5;

      try {
        const { rows: [existing] } = await db.execute({ sql: 'SELECT id FROM products WHERE sku = ?', args: [sku] });
        const vals = [
          name, description||null, model_number||null, size||null, category_id, parseNum(tax_rate)||8.5,
          taxable === '' || taxable == null ? 1 : (parseNum(taxable) ? 1 : 0), qty, minStk,
          classification, parseNum(daily_rate)||0, parseNum(weekly_rate)||0, parseNum(monthly_rate)||0, parseNum(hourly_rate)||0,
          parseNum(replacement_value)||0, parseNum(is_accessory) ? 1 : 0, active === '' || active == null ? 1 : (parseNum(active) ? 1 : 0),
        ];
        let productId;
        if (existing) {
          productId = existing.id;
          await db.execute({ sql: `UPDATE products SET name=?,description=?,model_number=?,size=?,category_id=?,tax_rate=?,taxable=?,stock_qty=?,min_stock=?,
            rental_classification=?,rental_rate=?,rental_weekly_rate=?,rental_monthly_rate=?,rental_hourly_rate=?,
            replacement_value=?,is_accessory=?,active=?,is_rental=1 WHERE id=?`, args: [...vals, productId] });
          updated++;
        } else {
          const result = await db.execute({ sql: `INSERT INTO products (sku,name,description,model_number,size,category_id,tax_rate,taxable,stock_qty,min_stock,
            rental_classification,rental_rate,rental_weekly_rate,rental_monthly_rate,rental_hourly_rate,
            replacement_value,is_accessory,active,is_rental,price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0)`, args: [sku, ...vals] });
          productId = Number(result.lastInsertRowid);
          created++;
        }

        // Single-branch move model — same as PUT /:id's branch_id handling.
        await db.execute({ sql: 'DELETE FROM branch_inventory WHERE product_id = ? AND branch_id != ?', args: [productId, branch_id || 0] });
        if (branch_id) {
          await db.execute({
            sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock) VALUES (?, ?, ?, ?)
                  ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = ?, min_stock = ?, updated_at = CURRENT_TIMESTAMP`,
            args: [productId, branch_id, qty, minStk, qty, minStk],
          });
        }
      } catch (e) { errors.push(`Row ${rowNum} (${sku}): ${e.message}`); }
    }

    res.json({ created, updated, errors, total: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET per-product stock movement history (sales, transfers, adjustments)
router.get('/:id/movements', requirePermission('inventory'), async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await db.execute({ sql: `
      SELECT type, date, qty, branch_name, reference, detail FROM (
        SELECT 'sale' as type, t.created_at as date, -ti.quantity as qty,
          COALESCE(b.name, 'Unknown') as branch_name, t.transaction_number as reference, 'Sold' as detail
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        LEFT JOIN branches b ON t.branch_id = b.id
        WHERE ti.product_id = ? AND t.status != 'voided'
        UNION ALL
        SELECT 'transfer_out', t.created_at, -ti.quantity_requested,
          fb.name, t.transfer_number, 'To ' || tb.name || ' (' || t.status || ')'
        FROM branch_transfer_items ti
        JOIN branch_transfers t ON ti.transfer_id = t.id
        JOIN branches fb ON t.from_branch_id = fb.id
        JOIN branches tb ON t.to_branch_id = tb.id
        WHERE ti.product_id = ?
        UNION ALL
        SELECT 'transfer_in', t.received_at, ti.quantity_received,
          tb.name, t.transfer_number, 'From ' || fb.name
        FROM branch_transfer_items ti
        JOIN branch_transfers t ON ti.transfer_id = t.id
        JOIN branches fb ON t.from_branch_id = fb.id
        JOIN branches tb ON t.to_branch_id = tb.id
        WHERE ti.product_id = ? AND t.status = 'received' AND ti.quantity_received > 0
        UNION ALL
        SELECT 'adjustment', sm.created_at, sm.quantity_change,
          COALESCE(b.name, 'All Branches'), NULL, COALESCE(sm.reason, 'Manual adjustment')
        FROM stock_movements sm
        LEFT JOIN branches b ON sm.branch_id = b.id
        WHERE sm.product_id = ?
      ) ORDER BY date DESC LIMIT 15`, args: [id, id, id, id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET single product
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { online, branch_id } = req.query;
    if (online === '1' || online === 'true') {
      const { rows: [setting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_sync_branch_id'", args: [] });
      const syncBranchId = setting?.value;
      const onlineParams = [req.params.id];
      let stockExpr, joinClause = '';
      if (syncBranchId) {
        joinClause = ` LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ?`;
        onlineParams.unshift(syncBranchId);
        stockExpr = `CASE WHEN p.web_allotment IS NOT NULL THEN MIN(COALESCE(bi.stock_qty, 0), p.web_allotment) ELSE COALESCE(bi.stock_qty, 0) END`;
      } else {
        stockExpr = `CASE WHEN p.web_allotment IS NOT NULL THEN MIN(COALESCE(p.stock_qty, 0), p.web_allotment) ELSE COALESCE(p.stock_qty, 0) END`;
      }
      const { rows: [product] } = await db.execute({
        sql: `SELECT p.id, p.sku, p.name, p.description, p.category_id, p.price, p.cost, p.tax_rate,
          p.active, p.image_path, p.is_service, p.unit,
          p.online_available, p.web_allotment, p.stock_qty as global_stock_qty,
          ${stockExpr} as stock_qty, c.name as category_name
          FROM products p LEFT JOIN categories c ON p.category_id = c.id${joinClause} WHERE p.id = ?`,
        args: onlineParams
      });
      if (!product) return res.status(404).json({ error: 'Product not found' });
      return res.json(product);
    }
    const { rows: [product] } = await db.execute({ sql: `SELECT p.*, c.name as category_name,
      (SELECT branch_id FROM branch_inventory WHERE product_id = p.id LIMIT 1) as assigned_branch_id
      FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`, args: [req.params.id] });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    // Additive fields only — used by the product form's Bin Locations panel to show
    // the branch-scoped stock figure that bin quantities must split accurately against.
    if (branch_id) {
      const { rows: [bi] } = await db.execute({ sql: 'SELECT stock_qty, min_stock FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [req.params.id, branch_id] });
      product.branch_stock_qty = bi ? bi.stock_qty : 0;
      product.branch_min_stock = bi ? bi.min_stock : product.min_stock;
    }
    res.json(product);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create product
// Create/edit/delete are shared by three different frontend forms — Inventory,
// Services, and Rentals items all go through this same endpoint — so the
// permission required is chosen per-request based on the product's own type
// (see requireProductPermission above), not any-of-the-three statically.
router.post('/', (req, res, next) => requireProductPermission(!!req.body.is_rental, !!req.body.is_service)(req, res, next), async (req, res) => {
  const { sku, barcode, name, description, category_id, price, cost, tax_rate, stock_qty, min_stock, active, branch_id, supplier_id, is_service, unit, online_available, web_allotment, is_rental, rental_rate_type, rental_rate, rental_deposit, rental_late_fee_rate, replacement_value, rental_classification, rental_weekly_rate, rental_monthly_rate, rental_hourly_rate, rental_allow_sale, is_accessory, is_layaway_eligible, model_number, size, brand, taxable } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'SKU and name are required' });
  try {
    const svc = is_service ? 1 : 0;
    const rnt = is_rental ? 1 : 0;
    const acc = is_accessory ? 1 : 0;
    const lay = is_layaway_eligible ? 1 : 0;
    const tax = taxable === undefined ? 1 : (taxable ? 1 : 0);
    const allowSale = rental_allow_sale ? 1 : 0;
    const result = await db.execute({ sql: `INSERT INTO products (sku,barcode,name,description,category_id,price,cost,tax_rate,stock_qty,min_stock,active,supplier_id,is_service,unit,online_available,web_allotment,is_rental,rental_rate_type,rental_rate,rental_deposit,rental_late_fee_rate,replacement_value,rental_classification,rental_weekly_rate,rental_monthly_rate,rental_hourly_rate,rental_allow_sale,is_accessory,is_layaway_eligible,model_number,size,brand,taxable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [sku, barcode||null, name, description||null, category_id||null, price||0, cost||0, tax_rate??8.5, svc ? 0 : (stock_qty||0), svc ? 0 : (min_stock||5), active??1, supplier_id||null, svc, unit||null, online_available?1:0, web_allotment!=null?parseInt(web_allotment):null, rnt, rental_rate_type||'daily', rental_rate||0, rental_deposit||0, rental_late_fee_rate||0, replacement_value||0, rental_classification||'tool', rental_weekly_rate||0, rental_monthly_rate||0, rental_hourly_rate||0, allowSale, acc, lay, model_number||null, size||null, brand||null, tax] });
    const productId = Number(result.lastInsertRowid);
    if (!svc && branch_id && (parseInt(stock_qty) || 0) > 0) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO branch_inventory (product_id, branch_id, stock_qty, min_stock) VALUES (?, ?, ?, ?)', args: [productId, branch_id, parseInt(stock_qty) || 0, parseInt(min_stock) || 5] });
    }
    const { rows: [prod] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [productId] });
    res.status(201).json(prod);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT update product
router.put('/:id', async (req, res, next) => {
  // Gate by the row's type after this write (existing DB state OR'd with the
  // incoming payload) — not just the payload alone — so a rental item can't
  // be edited by someone lacking rentals_manage_items merely by omitting
  // is_rental from the request body.
  if (req.apiKey) return next();
  if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
  const { rows: [existing] } = await db.execute({ sql: 'SELECT is_rental, is_service FROM products WHERE id = ?', args: [req.params.id] });
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  const key = requiredProductPermission(!!existing.is_rental || !!req.body.is_rental, !!existing.is_service || !!req.body.is_service);
  if (!can(req.employee.permissions, key)) return res.status(403).json({ error: `Missing permission: ${key}` });
  next();
}, async (req, res) => {
  const { sku, barcode, name, description, category_id, price, cost, tax_rate, stock_qty, min_stock, active, branch_id, supplier_id, is_service, unit, online_available, web_allotment, is_rental, rental_rate_type, rental_rate, rental_deposit, rental_late_fee_rate, replacement_value, rental_classification, rental_weekly_rate, rental_monthly_rate, rental_hourly_rate, rental_allow_sale, is_accessory, is_layaway_eligible, model_number, size, brand, taxable } = req.body;
  try {
    const svc = is_service ? 1 : 0;
    const rnt = is_rental ? 1 : 0;
    const acc = is_accessory ? 1 : 0;
    const lay = is_layaway_eligible ? 1 : 0;
    const tax = taxable === undefined ? 1 : (taxable ? 1 : 0);
    const allowSale = rental_allow_sale ? 1 : 0;
    // Rental items live at a single branch — reassigning the dropdown moves
    // the stock there instantly, with no audit trail or driver hand-off.
    // That's fine for a never-rented item, but moving it out from under units
    // that are still out on an active rental would strand that rental's
    // return at a branch the item no longer shows as belonging to — checked
    // here, before any write, so a rejected move doesn't leave the rest of
    // the edit (rates, name, etc.) half-saved. Use Branch Transfers instead
    // once there's outstanding stock to move deliberately.
    if (rnt && branch_id !== undefined) {
      const { rows: [currentBI] } = await db.execute({ sql: 'SELECT branch_id FROM branch_inventory WHERE product_id = ?', args: [req.params.id] });
      const oldBranchId = currentBI?.branch_id || null;
      if (oldBranchId && String(oldBranchId) !== String(branch_id || '')) {
        const outstanding = await getOutstandingQty(db, req.params.id, oldBranchId);
        if (outstanding > 0) {
          return res.status(400).json({ error: `${outstanding} unit(s) are still out on active rentals from its current branch — use Branch Transfers to move the available stock instead, or wait until they're returned.` });
        }
      }
    }
    await db.execute({ sql: `UPDATE products SET sku=?,barcode=?,name=?,description=?,category_id=?,price=?,cost=?,tax_rate=?,stock_qty=?,min_stock=?,active=?,supplier_id=?,is_service=?,unit=?,online_available=?,web_allotment=?,is_rental=?,rental_rate_type=?,rental_rate=?,rental_deposit=?,rental_late_fee_rate=?,replacement_value=?,rental_classification=?,rental_weekly_rate=?,rental_monthly_rate=?,rental_hourly_rate=?,rental_allow_sale=?,is_accessory=?,is_layaway_eligible=?,model_number=?,size=?,brand=?,taxable=? WHERE id=?`, args: [sku, barcode||null, name, description||null, category_id||null, price||0, cost||0, tax_rate??8.5, svc ? 0 : (stock_qty||0), svc ? 0 : (min_stock||5), active??1, supplier_id||null, svc, unit||null, online_available?1:0, web_allotment!=null?parseInt(web_allotment):null, rnt, rental_rate_type||'daily', rental_rate||0, rental_deposit||0, rental_late_fee_rate||0, replacement_value||0, rental_classification||'tool', rental_weekly_rate||0, rental_monthly_rate||0, rental_hourly_rate||0, allowSale, acc, lay, model_number||null, size||null, brand||null, tax, req.params.id] });
    if (rnt && branch_id !== undefined) {
      await db.execute({ sql: 'DELETE FROM branch_inventory WHERE product_id = ? AND branch_id != ?', args: [req.params.id, branch_id || 0] });
      if (branch_id) {
        await db.execute({
          sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock) VALUES (?, ?, ?, ?)
                ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = ?, min_stock = ?, updated_at = CURRENT_TIMESTAMP`,
          args: [req.params.id, branch_id, stock_qty||0, min_stock||5, stock_qty||0, min_stock||5],
        });
      }
    } else if (!svc && !rnt) {
      // The edit form has no branch picker for existing products, so a plain
      // Stock Qty change here only ever touched the global products.stock_qty
      // column — branch_inventory (what POS availability and branch-filtered
      // views actually read) stayed stale until something else, like a
      // transfer, happened to write to it. When the item lives at exactly one
      // branch (the common case — assigned once at creation, never split by
      // a transfer), keep that row in sync so the new stock is actually
      // sellable there. A product already split across multiple branches is
      // left alone since there's no way to tell which branch the edit meant.
      const { rows: biRows } = await db.execute({ sql: 'SELECT branch_id FROM branch_inventory WHERE product_id = ?', args: [req.params.id] });
      if (biRows.length === 1) {
        await db.execute({
          sql: 'UPDATE branch_inventory SET stock_qty = ?, min_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?',
          args: [stock_qty||0, min_stock||5, req.params.id, biRows[0].branch_id],
        });
      }
    }
    const { rows: [prod] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
    res.json(prod);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Merge a duplicate product (:id) into another (target_id) — combines stock
// and repoints every table that references the duplicate, then deactivates
// it rather than deleting it. See lib/productMerge.js for the full list of
// what moves and why it's not a hard delete.
router.post('/:id/merge', requirePermission('inventory_edit'), async (req, res) => {
  try {
    const { target_id } = req.body;
    if (!target_id) return res.status(400).json({ error: 'A product to merge into is required' });
    const updated = await mergeProducts(parseInt(req.params.id), parseInt(target_id));
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH adjust stock (global or branch-specific)
router.patch('/:id/stock', requirePermission('inventory'), async (req, res) => {
  try {
    const { adjustment, reason, branch_id } = req.body;
    const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const adj = parseInt(adjustment) || 0;

    if (branch_id) {
      const { rows: [existing] } = await db.execute({ sql: 'SELECT * FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [req.params.id, branch_id] });
      const currentQty = existing ? existing.stock_qty : 0;
      const newQty = currentQty + adj;
      await db.execute({ sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = ?, updated_at = CURRENT_TIMESTAMP`,
        args: [req.params.id, branch_id, newQty, existing ? existing.min_stock : product.min_stock, newQty] });
      await syncBinQty(db, req.params.id, branch_id, adj);
      await db.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [adj, req.params.id] });
      await db.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reason) VALUES (?, ?, ?, ?, ?)', args: [req.params.id, branch_id, adj, 'adjustment', reason || null] });
      return res.json({ stock_qty: newQty, branch_id });
    }

    const newQty = product.stock_qty + adj;
    await db.execute({ sql: 'UPDATE products SET stock_qty = ? WHERE id = ?', args: [newQty, req.params.id] });
    await db.execute({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reason) VALUES (?, ?, ?, ?, ?)', args: [req.params.id, null, adj, 'adjustment', reason || null] });
    res.json({ stock_qty: newQty });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH promote a non-inventory (quote-sourced) product into normal inventory
router.patch('/:id/promote-to-inventory', requirePermission('inventory'), async (req, res) => {
  try {
    const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await db.execute({ sql: 'UPDATE products SET is_non_inventory = 0 WHERE id = ?', args: [req.params.id] });
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE product
router.delete('/:id', async (req, res, next) => {
  if (req.apiKey) return next();
  if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
  const { rows: [existing] } = await db.execute({ sql: 'SELECT is_rental, is_service FROM products WHERE id = ?', args: [req.params.id] });
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  const key = requiredProductPermission(!!existing.is_rental, !!existing.is_service);
  if (!can(req.employee.permissions, key)) return res.status(403).json({ error: `Missing permission: ${key}` });
  next();
}, async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE products SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload product image
router.post('/:id/image', requireImagePermission, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT sku, image_path FROM products WHERE id = ?', args: [req.params.id] });
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (existing.image_path) {
      if (existing.image_path.startsWith('https://')) {
        await cloudDestroy(existing.image_path);
      } else {
        const old = path.join(__dirname, '..', existing.image_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const skuSlug = sanitizeSkuForFilename(existing.sku);
    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/products',
      public_id: skuSlug,
      overwrite: true,
      resource_type: 'image',
    });

    let imagePath;
    if (result) {
      imagePath = result.secure_url;
    } else {
      // Cloudinary not configured — save locally
      const dir = path.join(__dirname, '../uploads/products');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `${skuSlug}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      imagePath = `/uploads/products/${filename}`;
    }

    await db.execute({ sql: 'UPDATE products SET image_path = ? WHERE id = ?', args: [imagePath, req.params.id] });
    res.json({ image_path: imagePath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST scan uploads/products/ for image files already named after a SKU
// (e.g. someone FTP'd a batch of product photos in bulk) and assign each to
// its matching product. Matching is case-insensitive against the same
// sanitizeSkuForFilename() slug the upload route above writes, so "abc/123"
// (SKU) matches a file named "abc_123.jpg" or "ABC_123.PNG". Runs the file
// through Cloudinary when configured — same as a normal upload — so a scan
// on a Vercel deployment doesn't leave the image on ephemeral local disk.
router.post('/images/scan-folder', requirePermission('inventory'), async (req, res) => {
  try {
    const dir = path.join(__dirname, '../uploads/products');
    if (!fs.existsSync(dir)) return res.json({ matched: 0, scanned: 0, details: [] });

    const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|gif|webp|bmp)$/i.test(f));
    const { rows: products } = await db.execute({ sql: 'SELECT id, sku, image_path FROM products', args: [] });
    const bySlug = new Map();
    for (const p of products) bySlug.set(sanitizeSkuForFilename(p.sku).toLowerCase(), p);

    let matched = 0;
    const details = [];
    for (const file of files) {
      const base = path.parse(file).name;
      const product = bySlug.get(base.toLowerCase());
      if (!product) continue;
      if (product.image_path === `/uploads/products/${file}`) continue; // already assigned to this exact file

      const buffer = fs.readFileSync(path.join(dir, file));
      if (product.image_path) {
        if (product.image_path.startsWith('https://')) await cloudDestroy(product.image_path);
        else {
          const old = path.join(__dirname, '..', product.image_path);
          if (fs.existsSync(old) && old !== path.join(dir, file)) fs.unlinkSync(old);
        }
      }

      const skuSlug = sanitizeSkuForFilename(product.sku);
      const result = await cloudUpload(buffer, {
        folder: 'pos-system/products',
        public_id: skuSlug,
        overwrite: true,
        resource_type: 'image',
      });

      let imagePath;
      if (result) {
        imagePath = result.secure_url;
        fs.unlinkSync(path.join(dir, file)); // pushed to Cloudinary — don't leave a stale local copy
      } else {
        imagePath = `/uploads/products/${file}`;
      }

      await db.execute({ sql: 'UPDATE products SET image_path = ? WHERE id = ?', args: [imagePath, product.id] });
      matched++;
      details.push({ sku: product.sku, file });
    }

    res.json({ matched, scanned: files.length, details });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE product image
router.delete('/:id/image', requireImagePermission, async (req, res) => {
  try {
    const { rows: [product] } = await db.execute({ sql: 'SELECT image_path FROM products WHERE id = ?', args: [req.params.id] });
    if (product?.image_path) {
      if (product.image_path.startsWith('https://')) {
        await cloudDestroy(product.image_path);
      } else {
        const filePath = path.join(__dirname, '..', product.image_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      await db.execute({ sql: 'UPDATE products SET image_path = NULL WHERE id = ?', args: [req.params.id] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET variation types for a product
// requireAuth only — the POS variation picker (any cashier adding a
// variable product to cart) reads these too, not just Inventory management.
router.get('/:id/variation-types', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM product_variation_types WHERE product_id = ? ORDER BY sort_order, id', args: [req.params.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT save variation types (replaces all)
router.put('/:id/variation-types', requirePermission('inventory'), async (req, res) => {
  const { types } = req.body;
  if (!Array.isArray(types)) return res.status(400).json({ error: 'types must be an array' });
  try {
    await db.execute({ sql: 'DELETE FROM product_variation_types WHERE product_id = ?', args: [req.params.id] });
    for (let i = 0; i < types.length; i++) {
      const { name, values } = types[i];
      if (name && Array.isArray(values) && values.length) {
        await db.execute({ sql: 'INSERT INTO product_variation_types (product_id, name, attr_values, sort_order) VALUES (?,?,?,?)', args: [req.params.id, name, JSON.stringify(values), i] });
      }
    }
    const { rows } = await db.execute({ sql: 'SELECT * FROM product_variation_types WHERE product_id = ? ORDER BY sort_order', args: [req.params.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET variations for a product
router.get('/:id/variations', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE product_id = ? ORDER BY name', args: [req.params.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create a variation
router.post('/:id/variations', requirePermission('inventory'), async (req, res) => {
  const { name, sku, barcode, attributes, price, price_modifier, cost, stock_qty, min_stock, active } = req.body;
  if (!name || !sku) return res.status(400).json({ error: 'Name and SKU are required' });
  try {
    const result = await db.execute({ sql: 'INSERT INTO product_variations (product_id,name,sku,barcode,attributes,price,price_modifier,cost,stock_qty,min_stock,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [req.params.id, name, sku, barcode||null, JSON.stringify(attributes||{}), price!=null?price:null, price_modifier||0, cost!=null?cost:null, stock_qty||0, min_stock||5, active??1] });
    const { rows: [v] } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(v);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// PUT update a variation
router.put('/:id/variations/:vid', requirePermission('inventory'), async (req, res) => {
  const { name, sku, barcode, attributes, price, price_modifier, cost, stock_qty, min_stock, active } = req.body;
  try {
    await db.execute({ sql: 'UPDATE product_variations SET name=?,sku=?,barcode=?,attributes=?,price=?,price_modifier=?,cost=?,stock_qty=?,min_stock=?,active=? WHERE id=? AND product_id=?', args: [name, sku, barcode||null, JSON.stringify(attributes||{}), price!=null?price:null, price_modifier||0, cost!=null?cost:null, stock_qty||0, min_stock||5, active??1, req.params.vid, req.params.id] });
    const { rows: [v] } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE id = ?', args: [req.params.vid] });
    res.json(v);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// DELETE a variation
router.delete('/:id/variations/:vid', requirePermission('inventory'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM product_variations WHERE id = ? AND product_id = ?', args: [req.params.vid, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH adjust stock for a variation
router.patch('/:id/variations/:vid/stock', requirePermission('inventory'), async (req, res) => {
  try {
    const { adjustment } = req.body;
    const adj = parseInt(adjustment) || 0;
    const { rows: [v] } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE id = ? AND product_id = ?', args: [req.params.vid, req.params.id] });
    if (!v) return res.status(404).json({ error: 'Variation not found' });
    const newQty = Math.max(0, v.stock_qty + adj);
    await db.execute({ sql: 'UPDATE product_variations SET stock_qty = ? WHERE id = ?', args: [newQty, req.params.vid] });
    res.json({ stock_qty: newQty });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Rental accessory assignments ──────────────────────────────────────────
// Which accessory products can be bundled with a given rental item, and
// whether each one is mandatory (free) or optional (adds its own rental
// cost) — see routes/rentals.js's checkout handler for how these are billed.

router.get('/:id/accessories', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT pa.id, pa.product_id, pa.accessory_product_id, pa.is_mandatory,
      p.sku, p.name, p.rental_classification, p.rental_rate, p.rental_weekly_rate, p.rental_monthly_rate, p.rental_hourly_rate,
      p.tax_rate, p.stock_qty
      FROM product_accessories pa JOIN products p ON pa.accessory_product_id = p.id
      WHERE pa.product_id = ? ORDER BY pa.is_mandatory DESC, p.name`, args: [req.params.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/accessories', requirePermission('rentals_manage_items'), async (req, res) => {
  try {
    const { accessory_product_id, is_mandatory } = req.body;
    if (!accessory_product_id) return res.status(400).json({ error: 'accessory_product_id is required' });
    if (Number(accessory_product_id) === Number(req.params.id)) return res.status(400).json({ error: 'An item cannot be its own accessory' });
    const { rows: [accProd] } = await db.execute({ sql: 'SELECT id, is_rental FROM products WHERE id = ?', args: [accessory_product_id] });
    if (!accProd || !accProd.is_rental) return res.status(400).json({ error: 'Accessory must be an existing rental item' });
    await db.execute({ sql: `INSERT INTO product_accessories (product_id, accessory_product_id, is_mandatory) VALUES (?, ?, ?)
      ON CONFLICT(product_id, accessory_product_id) DO UPDATE SET is_mandatory = excluded.is_mandatory`,
      args: [req.params.id, accessory_product_id, is_mandatory ? 1 : 0] });
    res.status(201).json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id/accessories/:accessoryId', requirePermission('rentals_manage_items'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM product_accessories WHERE product_id = ? AND id = ?', args: [req.params.id, req.params.accessoryId] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
