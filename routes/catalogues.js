const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { renderCataloguePdf } = require('../lib/catalogue');

// Saved product catalogues (Inventory > Catalogues). A catalogue is a named
// selection — products in the chosen categories and/or brands, minus any
// individually unticked — rendered to PDF on demand, so a re-download always
// carries current names, prices and images. Gated by inventory_export since
// it's an export of product data.
router.use(requirePermission('inventory_export'));

const parseList = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

// Products a catalogue's selection covers: active, sellable (not services,
// not rental-only), in any chosen category AND any chosen brand — when only
// one of the two is chosen, just that one applies. Ordered by category then
// name, which is how the PDF groups them.
async function selectProducts({ category_ids = [], brands = [] }) {
  const cats = category_ids.map(Number).filter(Boolean);
  const brandList = brands.map(b => String(b).trim()).filter(Boolean);
  if (!cats.length && !brandList.length) return [];
  let sql = `SELECT p.id, p.name, p.sku, p.price, p.brand, p.description, p.image_path, p.category_id, c.name as category_name
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.active = 1 AND p.merged_into_product_id IS NULL AND COALESCE(p.is_service, 0) = 0
      AND (COALESCE(p.is_rental, 0) = 0 OR COALESCE(p.rental_allow_sale, 0) = 1)`;
  const args = [];
  if (cats.length) { sql += ` AND p.category_id IN (${cats.map(() => '?').join(',')})`; args.push(...cats); }
  if (brandList.length) { sql += ` AND p.brand COLLATE NOCASE IN (${brandList.map(() => '?').join(',')})`; args.push(...brandList); }
  sql += ' ORDER BY c.name COLLATE NOCASE, p.name COLLATE NOCASE';
  const { rows } = await db.execute({ sql, args });
  return rows;
}

function cleanBody(body) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Catalogue name is required');
  const category_ids = (Array.isArray(body.category_ids) ? body.category_ids : []).map(Number).filter(Boolean);
  const brands = (Array.isArray(body.brands) ? body.brands : []).map(b => String(b).trim()).filter(Boolean);
  if (!category_ids.length && !brands.length) throw new Error('Pick at least one category or brand');
  const excluded_product_ids = (Array.isArray(body.excluded_product_ids) ? body.excluded_product_ids : []).map(Number).filter(Boolean);
  return {
    name, description: String(body.description || '').trim() || null,
    category_ids, brands, excluded_product_ids, show_prices: body.show_prices === false || body.show_prices === 0 ? 0 : 1,
  };
}

const withLists = c => ({ ...c, category_ids: parseList(c.category_ids), brands: parseList(c.brands), excluded_product_ids: parseList(c.excluded_product_ids) });

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT pc.*, e.first_name || ' ' || e.last_name as created_by_name
      FROM product_catalogues pc LEFT JOIN employees e ON e.id = pc.created_by ORDER BY pc.updated_at DESC`, args: [] });
    res.json(rows.map(withLists));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Products a selection would include, for the form's tick list — called as
// the categories/brands change, before anything is saved.
router.post('/preview', async (req, res) => {
  try {
    res.json(await selectProducts({ category_ids: req.body.category_ids || [], brands: req.body.brands || [] }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows: [c] } = await db.execute({ sql: 'SELECT * FROM product_catalogues WHERE id = ?', args: [req.params.id] });
    if (!c) return res.status(404).json({ error: 'Catalogue not found' });
    res.json(withLists(c));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const c = cleanBody(req.body);
    const result = await db.execute({
      sql: `INSERT INTO product_catalogues (name, description, category_ids, brands, excluded_product_ids, show_prices, created_by) VALUES (?,?,?,?,?,?,?)`,
      args: [c.name, c.description, JSON.stringify(c.category_ids), JSON.stringify(c.brands), JSON.stringify(c.excluded_product_ids), c.show_prices, req.employee?.id || null],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const c = cleanBody(req.body);
    const result = await db.execute({
      sql: `UPDATE product_catalogues SET name=?, description=?, category_ids=?, brands=?, excluded_product_ids=?, show_prices=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      args: [c.name, c.description, JSON.stringify(c.category_ids), JSON.stringify(c.brands), JSON.stringify(c.excluded_product_ids), c.show_prices, req.params.id],
    });
    if (!result.rowsAffected) return res.status(404).json({ error: 'Catalogue not found' });
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM product_catalogues WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM product_catalogues WHERE id = ?', args: [req.params.id] });
    if (!row) return res.status(404).json({ error: 'Catalogue not found' });
    const catalogue = withLists(row);
    const excluded = new Set(catalogue.excluded_product_ids.map(Number));
    const products = (await selectProducts(catalogue)).filter(p => !excluded.has(Number(p.id)));
    if (!products.length) return res.status(400).json({ error: 'This catalogue has no products — edit it to pick categories or brands that contain products' });
    const { rows: settingRows } = await db.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('store_name','store_address','store_phone','store_email','currency','company_logo_url')", args: [] });
    const settings = Object.fromEntries(settingRows.map(r => [r.key, r.value]));
    const filename = `${catalogue.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'catalogue'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${filename}"`);
    await renderCataloguePdf(res, { catalogue, products, settings });
  } catch(e) {
    if (!res.headersSent) { res.removeHeader('Content-Disposition'); res.status(500).json({ error: e.message }); }
    else res.end();
  }
});

module.exports = router;
