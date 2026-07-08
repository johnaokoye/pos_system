const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../database');
const { hashKey } = require('../lib/apiKeyAuth');
const { requirePermission } = require('../lib/permissions');

// The API Keys card lives on the Settings page alongside company/tax/
// integrations config — same module-level gate as the rest of that screen.
router.use(requirePermission('settings'));

const VALID_SCOPES = [
  'products:read', 'products:write',
  'customers:read', 'customers:write',
  'orders:read', 'orders:write',
  '*',
];

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: 'SELECT id, name, key_prefix, scopes, created_at, last_used_at, is_active FROM api_keys ORDER BY created_at DESC',
      args: [],
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { name, scopes = ['*'] } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const invalid = scopes.filter(s => !VALID_SCOPES.includes(s));
    if (invalid.length) return res.status(400).json({ error: `Invalid scopes: ${invalid.join(', ')}` });

    const raw = 'pos_' + crypto.randomBytes(20).toString('hex'); // pos_ + 40 hex = 44 chars
    const prefix = raw.slice(0, 12);
    const hash = hashKey(raw);

    await db.execute({
      sql: 'INSERT INTO api_keys (name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?)',
      args: [name.trim(), prefix, hash, JSON.stringify(scopes)],
    });

    // Return the raw key only once — it is never stored
    res.status(201).json({ key: raw, prefix, name: name.trim(), scopes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const { name, scopes, is_active } = req.body;
    const updates = [];
    const args = [];

    if (name !== undefined) { updates.push('name = ?'); args.push(name.trim()); }
    if (scopes !== undefined) {
      const invalid = scopes.filter(s => !VALID_SCOPES.includes(s));
      if (invalid.length) return res.status(400).json({ error: `Invalid scopes: ${invalid.join(', ')}` });
      updates.push('scopes = ?'); args.push(JSON.stringify(scopes));
    }
    if (is_active !== undefined) { updates.push('is_active = ?'); args.push(is_active ? 1 : 0); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    args.push(req.params.id);
    await db.execute({ sql: `UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`, args });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE api_keys SET is_active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
