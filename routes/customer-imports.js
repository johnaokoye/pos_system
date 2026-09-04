const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

// POST start a new import batch — called once by the frontend before it
// starts POSTing CSV row-chunks to /customers/import with this id, so every
// chunk's customer_import_batch_items rows land under one reviewable/
// reversible unit even though the browser sends them as many small requests.
// Mirrors routes/product-imports.js.
router.post('/', requirePermission('customers'), async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'INSERT INTO customer_import_batches (employee_id, status) VALUES (?, ?)',
      args: [req.employee?.id || null, 'running'],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH mark a batch finished (all chunks posted) — purely informational for
// the list view; reverse works on a batch regardless of this status.
router.patch('/:id/finish', requirePermission('customers'), async (req, res) => {
  try {
    await db.execute({
      sql: "UPDATE customer_import_batches SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET list recent batches with counts aggregated from their logged items.
router.get('/', requirePermission('customers'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT b.id, b.status, b.started_at, b.finished_at, b.reversed_at,
        e.first_name || ' ' || e.last_name as employee_name,
        SUM(CASE WHEN i.action='created' THEN 1 ELSE 0 END) as created_count,
        SUM(CASE WHEN i.action='skipped_duplicate' THEN 1 ELSE 0 END) as skipped_count,
        SUM(CASE WHEN i.action='error' THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN i.reverse_outcome='deactivated' THEN 1 ELSE 0 END) as reversed_count
        FROM customer_import_batches b
        LEFT JOIN employees e ON b.employee_id = e.id
        LEFT JOIN customer_import_batch_items i ON i.batch_id = b.id
        GROUP BY b.id ORDER BY b.started_at DESC LIMIT 50`,
      args: [],
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET one batch's detail: metadata, per-action counts, and the list of rows
// skipped as likely duplicates (with which existing customer they matched)
// so the import can be reviewed before deciding whether to reverse it.
router.get('/:id', requirePermission('customers'), async (req, res) => {
  try {
    const { rows: [batch] } = await db.execute({
      sql: `SELECT b.*, e.first_name || ' ' || e.last_name as employee_name
        FROM customer_import_batches b LEFT JOIN employees e ON b.employee_id = e.id WHERE b.id = ?`,
      args: [req.params.id],
    });
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });

    const { rows: counts } = await db.execute({
      sql: `SELECT action, COUNT(*) as c FROM customer_import_batch_items WHERE batch_id = ? GROUP BY action`,
      args: [req.params.id],
    });
    const actionCounts = Object.fromEntries(counts.map(r => [r.action, r.c]));

    const { rows: duplicates } = await db.execute({
      sql: `SELECT i.row_label, c.id as customer_id, c.customer_number, c.first_name, c.last_name, c.email, c.phone
        FROM customer_import_batch_items i JOIN customers c ON c.id = i.duplicate_of_customer_id
        WHERE i.batch_id = ? AND i.action = 'skipped_duplicate' ORDER BY i.id`,
      args: [req.params.id],
    });

    const { rows: errorRows } = await db.execute({
      sql: `SELECT row_label, error_message FROM customer_import_batch_items WHERE batch_id = ? AND action = 'error' ORDER BY id`,
      args: [req.params.id],
    });

    res.json({ batch, counts: actionCounts, duplicates, errors: errorRows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST reverse an import batch: deactivates (active = 0) every customer this
// batch created — the same soft-delete DELETE /customers/:id already uses,
// so a reversed row behaves exactly like any other deactivated customer
// (no hard delete, no dependency bookkeeping needed). Skipped/error rows
// have nothing to undo.
router.post('/:id/reverse', requirePermission('customers'), async (req, res) => {
  try {
    const { rows: [batch] } = await db.execute({ sql: 'SELECT * FROM customer_import_batches WHERE id = ?', args: [req.params.id] });
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });
    if (batch.status === 'reversed') return res.status(400).json({ error: 'This import has already been reversed' });

    const { rows: createdItems } = await db.execute({
      sql: "SELECT id, customer_id, row_label FROM customer_import_batch_items WHERE batch_id = ? AND action = 'created' AND customer_id IS NOT NULL",
      args: [req.params.id],
    });

    const tx = await db.transaction('write');
    try {
      for (const item of createdItems) {
        await tx.execute({ sql: 'UPDATE customers SET active = 0 WHERE id = ?', args: [item.customer_id] });
        await tx.execute({ sql: "UPDATE customer_import_batch_items SET reverse_outcome = 'deactivated' WHERE id = ?", args: [item.id] });
      }
      await tx.execute({
        sql: "UPDATE customer_import_batches SET status = 'reversed', reversed_at = CURRENT_TIMESTAMP, reversed_by = ? WHERE id = ?",
        args: [req.employee?.id || null, req.params.id],
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    res.json({ deactivated: createdItems.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
