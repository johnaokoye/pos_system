const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { findDependentProductIds } = require('../lib/productDependents');
const { HAS_ISSUE_SQL, ISSUE_LABEL_SQL, rowsToCsv } = require('../lib/productIssues');

// POST start a new import batch — called once by the frontend before it
// starts POSTing CSV row-chunks to /products/import with this id, so every
// chunk's product_import_batch_items rows land under one reviewable/
// reversible unit even though the browser sends them as many small requests.
router.post('/', requirePermission('inventory'), async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'INSERT INTO product_import_batches (employee_id, status) VALUES (?, ?)',
      args: [req.employee?.id || null, 'running'],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH mark a batch finished (all chunks posted) or cancelled — purely
// informational for the list view; reverse works on a batch regardless of
// this status.
router.patch('/:id/finish', requirePermission('inventory'), async (req, res) => {
  try {
    await db.execute({
      sql: "UPDATE product_import_batches SET status = 'completed', finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET list recent batches with counts aggregated from their logged items.
router.get('/', requirePermission('inventory'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT b.id, b.status, b.started_at, b.finished_at, b.reversed_at,
        e.first_name || ' ' || e.last_name as employee_name,
        SUM(CASE WHEN i.action='created' THEN 1 ELSE 0 END) as created_count,
        SUM(CASE WHEN i.action='updated' THEN 1 ELSE 0 END) as updated_count,
        SUM(CASE WHEN i.action='skipped' THEN 1 ELSE 0 END) as skipped_count,
        SUM(CASE WHEN i.action='error' THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN i.reverse_outcome='deleted' THEN 1 ELSE 0 END) as reversed_deleted_count,
        SUM(CASE WHEN i.reverse_outcome='restored' THEN 1 ELSE 0 END) as reversed_restored_count
        FROM product_import_batches b
        LEFT JOIN employees e ON b.employee_id = e.id
        LEFT JOIN product_import_batch_items i ON i.batch_id = b.id
        GROUP BY b.id ORDER BY b.started_at DESC LIMIT 50`,
      args: [],
    });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET one batch's detail: metadata, per-action counts, and a data-quality
// breakdown (lib/productIssues.js) scoped to just the products this batch
// created or updated — the same checks used to review the 2026-09-02 import,
// now re-runnable for any batch at any time.
router.get('/:id', requirePermission('inventory'), async (req, res) => {
  try {
    const { rows: [batch] } = await db.execute({
      sql: `SELECT b.*, e.first_name || ' ' || e.last_name as employee_name
        FROM product_import_batches b LEFT JOIN employees e ON b.employee_id = e.id WHERE b.id = ?`,
      args: [req.params.id],
    });
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });

    const { rows: counts } = await db.execute({
      sql: `SELECT action, COUNT(*) as c FROM product_import_batch_items WHERE batch_id = ? GROUP BY action`,
      args: [req.params.id],
    });
    const actionCounts = Object.fromEntries(counts.map(r => [r.action, r.c]));

    const { rows: issues } = await db.execute({
      sql: `SELECT p.id, p.sku, p.name, p.price, p.cost, p.stock_qty, p.category_id, p.supplier_id, p.barcode,
        ${ISSUE_LABEL_SQL} as issue
        FROM products p
        WHERE p.id IN (
          SELECT product_id FROM product_import_batch_items
          WHERE batch_id = ? AND action IN ('created','updated') AND product_id IS NOT NULL
        ) AND ${HAS_ISSUE_SQL}`,
      args: [req.params.id],
    });

    res.json({ batch, counts: actionCounts, issue_count: issues.length, issues });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET export this batch's flagged (created/updated) products as CSV — same
// shape as GET /products/export/issues, just scoped to one batch.
router.get('/:id/export-issues', requirePermission('inventory'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT p.id, p.sku, p.name, p.price, p.cost, p.stock_qty,
        c.name as category_name, s.name as supplier_name, p.barcode,
        ${ISSUE_LABEL_SQL} as issue
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        WHERE p.id IN (
          SELECT product_id FROM product_import_batch_items
          WHERE batch_id = ? AND action IN ('created','updated') AND product_id IS NOT NULL
        ) AND ${HAS_ISSUE_SQL}
        ORDER BY p.sku`,
      args: [req.params.id],
    });
    const csv = rowsToCsv(rows, ['id','sku','name','price','cost','stock_qty','category_name','supplier_name','barcode','issue']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="import_${req.params.id}_issues.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST reverse an import batch:
//  - 'created' rows: deleted outright, UNLESS something real (a sale, a PO,
//    a logged stock adjustment, ...) has since touched that product — those
//    are left alone and reported back with why, rather than silently kept
//    or force-deleted into a corrupted foreign key.
//  - 'updated' rows: restored from the previous_values snapshot taken right
//    before the import overwrote them.
//  - 'skipped'/'error' rows: nothing to undo.
// Mirrors exactly the manual process used to reverse the 2026-09-02 import.
router.post('/:id/reverse', requirePermission('inventory'), async (req, res) => {
  try {
    const { rows: [batch] } = await db.execute({ sql: 'SELECT * FROM product_import_batches WHERE id = ?', args: [req.params.id] });
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });
    if (batch.status === 'reversed') return res.status(400).json({ error: 'This import has already been reversed' });

    const { rows: createdItems } = await db.execute({
      sql: "SELECT id, product_id, sku FROM product_import_batch_items WHERE batch_id = ? AND action = 'created' AND product_id IS NOT NULL",
      args: [req.params.id],
    });
    const { rows: updatedItems } = await db.execute({
      sql: "SELECT id, product_id, sku, previous_values FROM product_import_batch_items WHERE batch_id = ? AND action = 'updated' AND product_id IS NOT NULL",
      args: [req.params.id],
    });

    const createdIds = createdItems.map(r => r.product_id);
    const dependentReasons = await findDependentProductIds(db, createdIds);

    const deletableItems = createdItems.filter(r => !dependentReasons.has(r.product_id));
    const keptItems = createdItems.filter(r => dependentReasons.has(r.product_id));
    const deletableIds = deletableItems.map(r => r.product_id);

    const tx = await db.transaction('write');
    try {
      if (deletableIds.length) {
        const placeholders = deletableIds.map(() => '?').join(',');
        await tx.execute({ sql: `DELETE FROM branch_inventory WHERE product_id IN (${placeholders})`, args: deletableIds });
        await tx.execute({ sql: `DELETE FROM product_bin_assignments WHERE product_id IN (${placeholders})`, args: deletableIds });
        await tx.execute({ sql: `DELETE FROM products WHERE id IN (${placeholders})`, args: deletableIds });
      }
      for (const item of deletableItems) {
        await tx.execute({ sql: "UPDATE product_import_batch_items SET reverse_outcome = 'deleted' WHERE id = ?", args: [item.id] });
      }
      for (const item of keptItems) {
        const reasons = dependentReasons.get(item.product_id).join(', ');
        await tx.execute({ sql: "UPDATE product_import_batch_items SET reverse_outcome = ? WHERE id = ?", args: [`kept_has_dependents:${reasons}`, item.id] });
      }

      for (const item of updatedItems) {
        const prev = JSON.parse(item.previous_values);
        await tx.execute({
          sql: `UPDATE products SET sku=?,barcode=?,name=?,description=?,category_id=?,price=?,cost=?,tax_rate=?,stock_qty=?,min_stock=?,active=?,supplier_id=? WHERE id=?`,
          args: [prev.sku, prev.barcode, prev.name, prev.description, prev.category_id, prev.price, prev.cost, prev.tax_rate, prev.stock_qty, prev.min_stock, prev.active, prev.supplier_id, item.product_id],
        });
        await tx.execute({ sql: "UPDATE product_import_batch_items SET reverse_outcome = 'restored' WHERE id = ?", args: [item.id] });
      }

      await tx.execute({
        sql: "UPDATE product_import_batches SET status = 'reversed', reversed_at = CURRENT_TIMESTAMP, reversed_by = ? WHERE id = ?",
        args: [req.employee?.id || null, req.params.id],
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    res.json({
      deleted: deletableItems.length,
      restored: updatedItems.length,
      kept: keptItems.map(r => ({ sku: r.sku, reasons: dependentReasons.get(r.product_id) })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
