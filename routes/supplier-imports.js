const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

// Mirrors routes/customer-imports.js for CSV vendor imports (POST
// /suppliers/import). Starting an import and reviewing history need
// suppliers_add; reversing removes suppliers, so it needs suppliers_delete.

// POST start a new import batch — called once before the frontend posts its
// row-chunks to /suppliers/import with this id.
router.post('/', requirePermission('suppliers_add'), async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'INSERT INTO supplier_import_batches (employee_id, status) VALUES (?, ?)',
      args: [req.employee?.id || null, 'running'],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH mark a batch finished (all chunks posted) — informational only.
router.patch('/:id/finish', requirePermission('suppliers_add'), async (req, res) => {
  try {
    await db.execute({
      sql: "UPDATE supplier_import_batches SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET list recent batches with counts aggregated from their logged items.
router.get('/', requirePermission('suppliers_add'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT b.id, b.status, b.started_at, b.finished_at, b.reversed_at,
        e.first_name || ' ' || e.last_name as employee_name,
        SUM(CASE WHEN i.action='created' THEN 1 ELSE 0 END) as created_count,
        SUM(CASE WHEN i.action='skipped_duplicate' THEN 1 ELSE 0 END) as skipped_count,
        SUM(CASE WHEN i.action='error' THEN 1 ELSE 0 END) as error_count
        FROM supplier_import_batches b
        LEFT JOIN employees e ON b.employee_id = e.id
        LEFT JOIN supplier_import_batch_items i ON i.batch_id = b.id
        GROUP BY b.id ORDER BY b.started_at DESC LIMIT 50`,
      args: [],
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET one batch's detail: counts, duplicates skipped (and what they matched),
// row errors, and — once reversed — which suppliers were kept and why.
router.get('/:id', requirePermission('suppliers_add'), async (req, res) => {
  try {
    const { rows: [batch] } = await db.execute({
      sql: `SELECT b.*, e.first_name || ' ' || e.last_name as employee_name
        FROM supplier_import_batches b LEFT JOIN employees e ON b.employee_id = e.id WHERE b.id = ?`,
      args: [req.params.id],
    });
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });

    const { rows: counts } = await db.execute({
      sql: 'SELECT action, COUNT(*) as c FROM supplier_import_batch_items WHERE batch_id = ? GROUP BY action',
      args: [req.params.id],
    });
    const { rows: duplicates } = await db.execute({
      sql: `SELECT i.row_label, i.supplier_number as row_supplier_number, s.supplier_number, s.name
        FROM supplier_import_batch_items i LEFT JOIN suppliers s ON s.id = i.duplicate_of_supplier_id
        WHERE i.batch_id = ? AND i.action = 'skipped_duplicate' ORDER BY i.id`,
      args: [req.params.id],
    });
    const { rows: errors } = await db.execute({
      sql: "SELECT row_label, error_message FROM supplier_import_batch_items WHERE batch_id = ? AND action = 'error' ORDER BY id",
      args: [req.params.id],
    });
    const { rows: kept } = await db.execute({
      sql: "SELECT row_label, supplier_number, reverse_outcome FROM supplier_import_batch_items WHERE batch_id = ? AND reverse_outcome LIKE 'deactivated%' ORDER BY id",
      args: [req.params.id],
    });
    res.json({ batch, counts: Object.fromEntries(counts.map(r => [r.action, r.c])), duplicates, errors, kept });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Tables whose rows point at a supplier; one of these means the supplier is
// in use and can only be deactivated, not deleted.
const DEPENDENTS = [
  ['purchase_orders', 'purchase orders'],
  ['products', 'products'],
  ['purchase_requests', 'purchase requests'],
];

// POST reverse an import batch. Every supplier the batch created is deleted
// if nothing references it yet, otherwise deactivated (same soft-delete as
// DELETE /suppliers/:id) with the reason recorded on its batch item.
router.post('/:id/reverse', requirePermission('suppliers_delete'), async (req, res) => {
  try {
    const { rows: [batch] } = await db.execute({ sql: 'SELECT * FROM supplier_import_batches WHERE id = ?', args: [req.params.id] });
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });
    if (batch.status === 'reversed') return res.status(400).json({ error: 'This import has already been reversed' });

    const { rows: items } = await db.execute({
      sql: "SELECT id, supplier_id FROM supplier_import_batch_items WHERE batch_id = ? AND action = 'created' AND supplier_id IS NOT NULL",
      args: [req.params.id],
    });
    const reasons = new Map();
    if (items.length) {
      const ids = items.map(i => i.supplier_id);
      const placeholders = ids.map(() => '?').join(',');
      for (const [table, label] of DEPENDENTS) {
        const { rows } = await db.execute({ sql: `SELECT DISTINCT supplier_id FROM ${table} WHERE supplier_id IN (${placeholders})`, args: ids });
        for (const r of rows) reasons.set(r.supplier_id, [...(reasons.get(r.supplier_id) || []), label]);
      }
    }

    let deleted = 0, deactivated = 0;
    const tx = await db.transaction('write');
    try {
      for (const item of items) {
        const used = reasons.get(item.supplier_id);
        if (used) {
          await tx.execute({ sql: 'UPDATE suppliers SET active = 0 WHERE id = ?', args: [item.supplier_id] });
          await tx.execute({ sql: 'UPDATE supplier_import_batch_items SET reverse_outcome = ? WHERE id = ?', args: [`deactivated:${used.join(', ')}`, item.id] });
          deactivated++;
        } else {
          await tx.execute({ sql: 'UPDATE supplier_import_batch_items SET reverse_outcome = ?, supplier_id = NULL WHERE id = ?', args: ['deleted', item.id] });
          await tx.execute({ sql: 'UPDATE supplier_import_batch_items SET duplicate_of_supplier_id = NULL WHERE duplicate_of_supplier_id = ?', args: [item.supplier_id] });
          await tx.execute({ sql: 'DELETE FROM suppliers WHERE id = ?', args: [item.supplier_id] });
          deleted++;
        }
      }
      await tx.execute({
        sql: "UPDATE supplier_import_batches SET status = 'reversed', reversed_at = CURRENT_TIMESTAMP, reversed_by = ? WHERE id = ?",
        args: [req.employee?.id || null, req.params.id],
      });
      await tx.commit();
    } catch (e) {
      // Guarded: rolling back after a failed commit throws and would crash the process.
      await tx.rollback().catch(() => {});
      throw e;
    }
    res.json({ deleted, deactivated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
