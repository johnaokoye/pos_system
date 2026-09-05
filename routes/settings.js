const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// requireAuth only — loaded on app init for every logged-in user (tax rate
// defaults, currency, etc.), not just the Settings screen itself.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM settings', args: [] });
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    settings.build_commit = process.env.GIT_COMMIT || 'unknown';
    res.json(settings);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// No auth — the login screen needs the store name/logo before anyone is
// signed in, and this is the only pair of settings values safe to expose
// unauthenticated (everything else in the table, e.g. SMTP credentials,
// stays behind GET / above). build_commit isn't from the settings table at
// all — see Dockerfile/docker-compose.yml — but is just as safe to show
// pre-login: it's how to tell at a glance which commit a Docker deployment
// is actually running, without needing to shell into the container.
router.get('/public', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('store_name','company_logo_url')", args: [] });
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    settings.build_commit = process.env.GIT_COMMIT || 'unknown';
    res.json(settings);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/', requirePermission('settings'), async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await db.execute({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, value] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Upload/replace the company logo — same Cloudinary-or-local pattern as
// product images (routes/products.js POST /:id/image), just keyed into the
// settings table instead of a products row.
router.post('/logo', requirePermission('settings'), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'company_logo_url'", args: [] });
    if (existing?.value) {
      if (existing.value.startsWith('https://')) {
        await cloudDestroy(existing.value);
      } else {
        const old = path.join(__dirname, '..', existing.value);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/branding',
      public_id: 'company-logo',
      overwrite: true,
      resource_type: 'image',
    });

    let logoUrl;
    if (result) {
      logoUrl = result.secure_url;
    } else {
      // Cloudinary not configured — save locally
      const dir = path.join(__dirname, '../uploads/branding');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `company-logo-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      logoUrl = `/uploads/branding/${filename}`;
    }

    await db.execute({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['company_logo_url', logoUrl] });
    res.json({ logo_url: logoUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/logo', requirePermission('settings'), async (req, res) => {
  try {
    const { rows: [existing] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'company_logo_url'", args: [] });
    if (existing?.value) {
      if (existing.value.startsWith('https://')) {
        await cloudDestroy(existing.value);
      } else {
        const old = path.join(__dirname, '..', existing.value);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }
    await db.execute({ sql: "DELETE FROM settings WHERE key = 'company_logo_url'", args: [] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POS discount-excluded brands ────────────────────────────────────────
// Brands a manual POS line-item discount can never be applied to (checked
// by routes/promotions.js's discount-eligibility endpoint and re-checked
// server-side at checkout) — independent of any specific promotion's own
// brand rules.
router.get('/discount-excluded-brands', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM pos_discount_excluded_brands ORDER BY brand', args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/discount-excluded-brands', requirePermission('settings'), async (req, res) => {
  try {
    const brand = (req.body.brand || '').trim();
    if (!brand) return res.status(400).json({ error: 'A brand name is required' });
    const result = await db.execute({ sql: 'INSERT INTO pos_discount_excluded_brands (brand) VALUES (?)', args: [brand] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM pos_discount_excluded_brands WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message.includes('UNIQUE') ? 'That brand is already excluded' : e.message }); }
});

router.delete('/discount-excluded-brands/:id', requirePermission('settings'), async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM pos_discount_excluded_brands WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
