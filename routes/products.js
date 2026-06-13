const express = require('express');
const router = express.Router();
const { db } = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// GET all products
router.get('/', async (req, res) => {
  try {
    const { search, category, active, low_stock, branch_id, supplier_id } = req.query;
    const params = [];
    let sql;

    if (branch_id) {
      sql = `SELECT p.id, p.sku, p.barcode, p.name, p.description, p.category_id, p.price, p.cost, p.tax_rate, p.active, p.created_at, p.supplier_id, p.image_path,
        COALESCE(bi.stock_qty, 0) as stock_qty,
        COALESCE(bi.min_stock, p.min_stock) as min_stock,
        p.stock_qty as global_stock_qty,
        c.name as category_name,
        (SELECT COUNT(*) FROM product_variations WHERE product_id = p.id AND active = 1) as has_variations
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN branch_inventory bi ON p.id = bi.product_id AND bi.branch_id = ?
        WHERE 1=1`;
      params.push(branch_id);
    } else {
      sql = `SELECT p.*, c.name as category_name, (SELECT COUNT(*) FROM product_variations WHERE product_id = p.id AND active = 1) as has_variations FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE 1=1`;
    }

    if (search) {
      sql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category) { sql += ` AND p.category_id = ?`; params.push(category); }
    if (supplier_id) { sql += ` AND p.supplier_id = ?`; params.push(supplier_id); }
    if (active !== undefined) { sql += ` AND p.active = ?`; params.push(active); }
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
router.get('/movements', async (req, res) => {
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
router.get('/export', async (req, res) => {
  try {
    const { search, category, active, low_stock, branch_id, supplier_id } = req.query;
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

// GET CSV template for bulk import
router.get('/export/template', (req, res) => {
  const headers = ['sku','barcode','name','description','category_name','price','cost','tax_rate','stock_qty','min_stock','active','supplier_name'];
  const example = ['PROD-001','0001234567890','Example Product','Product description','Electronics','19.99','9.99','8.5','100','10','1','TechSupply Co'];
  const csv = [headers.join(','), example.join(',')].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="product_import_template.csv"');
  res.send(csv);
});

// POST import products from CSV rows
router.post('/import', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });

    const { rows: catRows } = await db.execute({ sql: 'SELECT id, name FROM categories', args: [] });
    const { rows: supRows } = await db.execute({ sql: 'SELECT id, name FROM suppliers', args: [] });
    const catMap = Object.fromEntries(catRows.map(c => [c.name.toLowerCase(), c.id]));
    const supMap = Object.fromEntries(supRows.map(s => [s.name.toLowerCase(), s.id]));

    let created = 0, updated = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const { sku, barcode, name, description, category_name, price, cost, tax_rate, stock_qty, min_stock, active, supplier_name } = row;
      if (!sku || !name) { errors.push(`Row ${rowNum}: SKU and name are required`); continue; }
      const category_id = category_name ? (catMap[category_name.toLowerCase()] ?? null) : null;
      const supplier_id = supplier_name ? (supMap[supplier_name.toLowerCase()] ?? null) : null;
      const vals = [barcode||null, name, description||null, category_id, parseFloat(price)||0, parseFloat(cost)||0, parseFloat(tax_rate)||8.5, parseInt(stock_qty)||0, parseInt(min_stock)||5, parseInt(active)??1, supplier_id];
      try {
        const { rows: [existing] } = await db.execute({ sql: 'SELECT id FROM products WHERE sku = ?', args: [sku] });
        if (existing) {
          await db.execute({ sql: 'UPDATE products SET barcode=?,name=?,description=?,category_id=?,price=?,cost=?,tax_rate=?,stock_qty=?,min_stock=?,active=?,supplier_id=? WHERE sku=?', args: [...vals, sku] });
          updated++;
        } else {
          await db.execute({ sql: 'INSERT INTO products (sku,barcode,name,description,category_id,price,cost,tax_rate,stock_qty,min_stock,active,supplier_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [sku, ...vals] });
          created++;
        }
      } catch (e) { errors.push(`Row ${rowNum} (${sku}): ${e.message}`); }
    }

    res.json({ created, updated, errors, total: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET per-product stock movement history (sales, transfers, adjustments)
router.get('/:id/movements', async (req, res) => {
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
router.get('/:id', async (req, res) => {
  try {
    const { rows: [product] } = await db.execute({ sql: `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`, args: [req.params.id] });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create product
router.post('/', async (req, res) => {
  const { sku, barcode, name, description, category_id, price, cost, tax_rate, stock_qty, min_stock, active, branch_id, supplier_id } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'SKU and name are required' });
  try {
    const result = await db.execute({ sql: `INSERT INTO products (sku,barcode,name,description,category_id,price,cost,tax_rate,stock_qty,min_stock,active,supplier_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [sku, barcode||null, name, description||null, category_id||null, price||0, cost||0, tax_rate??8.5, stock_qty||0, min_stock||5, active??1, supplier_id||null] });
    const productId = Number(result.lastInsertRowid);
    if (branch_id && (parseInt(stock_qty) || 0) > 0) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO branch_inventory (product_id, branch_id, stock_qty, min_stock) VALUES (?, ?, ?, ?)', args: [productId, branch_id, parseInt(stock_qty) || 0, parseInt(min_stock) || 5] });
    }
    const { rows: [prod] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [productId] });
    res.status(201).json(prod);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT update product
router.put('/:id', async (req, res) => {
  const { sku, barcode, name, description, category_id, price, cost, tax_rate, stock_qty, min_stock, active, supplier_id } = req.body;
  try {
    await db.execute({ sql: `UPDATE products SET sku=?,barcode=?,name=?,description=?,category_id=?,price=?,cost=?,tax_rate=?,stock_qty=?,min_stock=?,active=?,supplier_id=? WHERE id=?`, args: [sku, barcode||null, name, description||null, category_id||null, price||0, cost||0, tax_rate??8.5, stock_qty||0, min_stock||5, active??1, supplier_id||null, req.params.id] });
    const { rows: [prod] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
    res.json(prod);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH adjust stock (global or branch-specific)
router.patch('/:id/stock', async (req, res) => {
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

// DELETE product
router.delete('/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE products SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload product image
router.post('/:id/image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT image_path FROM products WHERE id = ?', args: [req.params.id] });
    if (existing?.image_path) {
      if (existing.image_path.startsWith('https://')) {
        await cloudDestroy(existing.image_path);
      } else {
        const old = path.join(__dirname, '..', existing.image_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/products',
      public_id: `product-${req.params.id}`,
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
      const filename = `product-${req.params.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      imagePath = `/uploads/products/${filename}`;
    }

    await db.execute({ sql: 'UPDATE products SET image_path = ? WHERE id = ?', args: [imagePath, req.params.id] });
    res.json({ image_path: imagePath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE product image
router.delete('/:id/image', async (req, res) => {
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
router.get('/:id/variation-types', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM product_variation_types WHERE product_id = ? ORDER BY sort_order, id', args: [req.params.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT save variation types (replaces all)
router.put('/:id/variation-types', async (req, res) => {
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
router.get('/:id/variations', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE product_id = ? ORDER BY name', args: [req.params.id] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create a variation
router.post('/:id/variations', async (req, res) => {
  const { name, sku, barcode, attributes, price, price_modifier, cost, stock_qty, min_stock, active } = req.body;
  if (!name || !sku) return res.status(400).json({ error: 'Name and SKU are required' });
  try {
    const result = await db.execute({ sql: 'INSERT INTO product_variations (product_id,name,sku,barcode,attributes,price,price_modifier,cost,stock_qty,min_stock,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: [req.params.id, name, sku, barcode||null, JSON.stringify(attributes||{}), price!=null?price:null, price_modifier||0, cost!=null?cost:null, stock_qty||0, min_stock||5, active??1] });
    const { rows: [v] } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(v);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// PUT update a variation
router.put('/:id/variations/:vid', async (req, res) => {
  const { name, sku, barcode, attributes, price, price_modifier, cost, stock_qty, min_stock, active } = req.body;
  try {
    await db.execute({ sql: 'UPDATE product_variations SET name=?,sku=?,barcode=?,attributes=?,price=?,price_modifier=?,cost=?,stock_qty=?,min_stock=?,active=? WHERE id=? AND product_id=?', args: [name, sku, barcode||null, JSON.stringify(attributes||{}), price!=null?price:null, price_modifier||0, cost!=null?cost:null, stock_qty||0, min_stock||5, active??1, req.params.vid, req.params.id] });
    const { rows: [v] } = await db.execute({ sql: 'SELECT * FROM product_variations WHERE id = ?', args: [req.params.vid] });
    res.json(v);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// DELETE a variation
router.delete('/:id/variations/:vid', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM product_variations WHERE id = ? AND product_id = ?', args: [req.params.vid, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH adjust stock for a variation
router.patch('/:id/variations/:vid/stock', async (req, res) => {
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

module.exports = router;
