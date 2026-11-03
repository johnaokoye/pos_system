#!/usr/bin/env node
// Reverses the "Count uncounted lines as 0" part of a committed cycle count,
// leaving the lines that were actually counted (imported) untouched.
//
//   node scripts/reverse-zero-uncounted.js CC-000123            # dry run (report only)
//   node scripts/reverse-zero-uncounted.js CC-000123 --apply    # make the changes
//   add --only-previously-counted to restrict to items counted in an earlier
//   committed session (e.g. Saturday's), leaving never-counted items at 0.
//
// A zero-filled line is one with counted_qty = 0 and no line in any active
// (not undone) upload of the session. Each is reversed by adding its variance
// back — the exact opposite of what the commit did — to products.stock_qty,
// branch_inventory and the bin, with an offsetting stock_movements row. Sales,
// receipts and transfers since the commit are therefore kept.
require('dotenv').config({ quiet: true });
const { db, ensureReady } = require('../database');

(async () => {
  const args = process.argv.slice(2);
  const sessionNumber = args.find(a => !a.startsWith('--'));
  const apply = args.includes('--apply');
  const onlyPrev = args.includes('--only-previously-counted');
  if (!sessionNumber) { console.error('Usage: node scripts/reverse-zero-uncounted.js <CC-number> [--apply] [--only-previously-counted]'); process.exit(1); }
  await ensureReady();
  console.log('Database:', process.env.TURSO_DATABASE_URL || 'file:pos.db (local)');

  const { rows: [s] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE session_number = ?', args: [sessionNumber] });
  if (!s) throw new Error(`No session ${sessionNumber}`);
  if (s.status !== 'committed') throw new Error(`${sessionNumber} is ${s.status}, not committed`);
  const reverseRef = `${sessionNumber}-REV`;
  const { rows: [done] } = await db.execute({ sql: 'SELECT COUNT(*) n FROM stock_movements WHERE reference = ?', args: [reverseRef] });
  if (Number(done.n)) throw new Error(`${sessionNumber} has already been reversed (${done.n} movements with reference ${reverseRef})`);

  const { rows: lines } = await db.execute({ sql: `
    SELECT ci.*, p.stock_qty AS global_now,
      (SELECT bi.stock_qty FROM branch_inventory bi WHERE bi.product_id = ci.product_id AND bi.branch_id = ?) AS branch_now,
      (SELECT MAX(pc.counted_qty) FROM cycle_count_items pc JOIN cycle_count_sessions ps ON ps.id = pc.session_id
         WHERE pc.product_id = ci.product_id AND ps.status = 'committed' AND ps.id != ci.session_id
           AND ps.committed_at < ? AND pc.counted_qty IS NOT NULL
           AND EXISTS (SELECT 1 FROM cycle_count_upload_lines l2 JOIN cycle_count_uploads u2 ON u2.id = l2.upload_id
                       WHERE l2.item_id = pc.id AND u2.undone_at IS NULL)) AS prev_counted,
      (SELECT COUNT(*) FROM stock_movements m WHERE m.product_id = ci.product_id AND m.type = 'adjustment'
         AND m.created_at > ? AND COALESCE(m.reference,'') != ?) AS later_adjustments
    FROM cycle_count_items ci LEFT JOIN products p ON p.id = ci.product_id
    WHERE ci.session_id = ? AND ci.counted_qty = 0 AND ci.variance != 0 AND ci.product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cycle_count_upload_lines l JOIN cycle_count_uploads u ON u.id = l.upload_id
                      WHERE l.item_id = ci.id AND u.undone_at IS NULL)
    ORDER BY ci.product_name`, args: [s.branch_id, s.committed_at, s.committed_at, sessionNumber, s.id] });

  const todo = lines.filter(l => !onlyPrev || l.prev_counted != null);
  const flagged = todo.filter(l => Number(l.later_adjustments));
  console.log(`\n${sessionNumber} (committed ${s.committed_at} UTC, branch ${s.branch_id ?? 'all'}): ${lines.length} zero-filled lines with a variance; ${todo.length} to reverse.`);
  console.log('SKU\tName\tBin\tZeroed by\tRestore +\tBranch now→after\tEarlier count\tNote');
  for (const l of todo) {
    const add = -Number(l.variance);
    const bn = l.branch_now == null ? 0 : Number(l.branch_now);
    console.log([l.sku, l.product_name, l.bin_code || '', l.variance, add, `${bn}→${bn + add}`, l.prev_counted ?? '—',
      Number(l.later_adjustments) ? 'ADJUSTED SINCE — skipped, check by hand' : ''].join('\t'));
  }
  if (flagged.length) console.log(`\n${flagged.length} item(s) were adjusted again after the commit and will be skipped.`);
  if (!apply) { console.log('\nDry run — nothing changed. Re-run with --apply to make these adjustments.'); return; }

  const stmts = [];
  for (const l of todo) {
    if (Number(l.later_adjustments)) continue;
    const add = -Number(l.variance);
    stmts.push({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [add, l.product_id] });
    if (l.bin_id) stmts.push({ sql: 'UPDATE product_bin_assignments SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND bin_id = ?', args: [add, l.product_id, l.bin_id] });
    if (s.branch_id) stmts.push({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [add, l.product_id, s.branch_id] });
    stmts.push({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)',
      args: [l.product_id, s.branch_id || null, add, 'adjustment', reverseRef, `Reversal of ${sessionNumber}: line was not counted, wrongly set to 0`] });
  }
  if (!stmts.length) { console.log('Nothing to apply.'); return; }
  await db.batch(stmts, 'write'); // one atomic transaction
  console.log(`\nApplied: ${todo.length - flagged.length} item(s) restored (reference ${reverseRef}).`);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
