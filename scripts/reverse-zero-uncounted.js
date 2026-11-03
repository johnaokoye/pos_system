#!/usr/bin/env node
// Reverses lines a committed cycle count wrongly set to 0, leaving the lines
// that were actually counted untouched.
//
//   node scripts/reverse-zero-uncounted.js CC-000123            # dry run (report only)
//   node scripts/reverse-zero-uncounted.js CC-000123 --apply    # make the changes
//
//   --only-previously-counted  only items counted in an earlier committed
//                              session (e.g. Saturday's); never-counted items stay 0.
//   --include-imported-zeros   also lines whose 0 came from an imported file (a
//                              sheet with 0 typed against items nobody counted).
//                              Use with --only-previously-counted, since a
//                              genuine "counted 0" looks the same.
//   --adjusted                 instead handle the items skipped because someone
//                              adjusted them by hand after the commit: undoes
//                              those hand adjustments as well as the zeroing, so
//                              the item ends where it would be had neither
//                              happened (sales/receipts/transfers since are kept).
//   --skus=A,B,C               limit to these SKUs (any mode).
//   --exclude=A,B              leave these SKUs out.
//
// Each line is reversed by adding back its variance (and, with --adjusted, the
// hand adjustments) to products.stock_qty, branch_inventory and the bin, with
// an offsetting stock_movements row referenced <CC-number>-REV. An item that
// already has such a row is never reversed again.
require('dotenv').config({ quiet: true });
const { db, ensureReady } = require('../database');

(async () => {
  const args = process.argv.slice(2);
  const sessionNumber = args.find(a => !a.startsWith('--'));
  const apply = args.includes('--apply');
  const onlyPrev = args.includes('--only-previously-counted');
  const withImported = args.includes('--include-imported-zeros');
  const adjustedMode = args.includes('--adjusted');
  const list = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1].split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : null; };
  const skus = list('skus'), exclude = list('exclude') || [];
  if (!sessionNumber) { console.error('Usage: node scripts/reverse-zero-uncounted.js <CC-number> [--apply] [--only-previously-counted] [--include-imported-zeros] [--adjusted] [--skus=A,B] [--exclude=A,B]'); process.exit(1); }
  await ensureReady();
  console.log('Database:', process.env.TURSO_DATABASE_URL || 'file:pos.db (local)');

  const { rows: [s] } = await db.execute({ sql: 'SELECT * FROM cycle_count_sessions WHERE session_number = ?', args: [sessionNumber] });
  if (!s) throw new Error(`No session ${sessionNumber}`);
  if (s.status !== 'committed') throw new Error(`${sessionNumber} is ${s.status}, not committed`);
  const reverseRef = `${sessionNumber}-REV`;
  const branchCond = s.branch_id ? 'm.branch_id = ?' : 'm.branch_id IS NULL';
  const branchArg = s.branch_id ? [s.branch_id] : [];

  const { rows: ups } = await db.execute({ sql: `SELECT u.id, u.device_label, u.file_name, u.mode, u.created_at, u.undone_at, u.line_count,
      (SELECT COUNT(*) FROM cycle_count_upload_lines l WHERE l.upload_id = u.id AND l.qty = 0) AS zero_lines
    FROM cycle_count_uploads u WHERE u.session_id = ? ORDER BY u.id`, args: [s.id] });
  console.log(`\nUploads in ${sessionNumber}:`);
  for (const u of ups) console.log(`  #${u.id} ${u.created_at} UTC  ${u.device_label || ''} ${u.file_name || ''} (${u.mode})  ${u.line_count} lines, ${u.zero_lines} of them 0${u.undone_at ? '  [undone]' : ''}`);

  // Hand adjustments after the commit, at the session's branch — anything but
  // this session's own movements and its reversals.
  const laterAdj = `FROM stock_movements m WHERE m.product_id = ci.product_id AND m.type = 'adjustment' AND ${branchCond}
         AND m.created_at > ? AND COALESCE(m.reference,'') NOT LIKE ?`;
  const { rows: lines } = await db.execute({ sql: `
    SELECT ci.*,
      (SELECT GROUP_CONCAT(DISTINCT '#' || u.id) FROM cycle_count_upload_lines l JOIN cycle_count_uploads u ON u.id = l.upload_id
         WHERE l.item_id = ci.id AND u.undone_at IS NULL) AS from_uploads,
      (SELECT bi.stock_qty FROM branch_inventory bi WHERE bi.product_id = ci.product_id AND bi.branch_id = ?) AS branch_now,
      (SELECT p.stock_qty FROM products p WHERE p.id = ci.product_id) AS global_now,
      (SELECT MAX(pc.counted_qty) FROM cycle_count_items pc JOIN cycle_count_sessions ps ON ps.id = pc.session_id
         WHERE pc.product_id = ci.product_id AND ps.status = 'committed' AND ps.id != ci.session_id
           AND ps.committed_at <= ? AND pc.counted_qty IS NOT NULL
           AND EXISTS (SELECT 1 FROM cycle_count_upload_lines l2 JOIN cycle_count_uploads u2 ON u2.id = l2.upload_id
                       WHERE l2.item_id = pc.id AND u2.undone_at IS NULL)) AS prev_counted,
      (SELECT COUNT(*) ${laterAdj}) AS later_count,
      (SELECT COALESCE(SUM(m.quantity_change), 0) ${laterAdj}) AS later_sum,
      (SELECT GROUP_CONCAT(m.created_at || ' UTC ' || (CASE WHEN m.quantity_change > 0 THEN '+' ELSE '' END) || m.quantity_change || ' ' || COALESCE(m.reason, ''), ' | ') ${laterAdj}) AS later_list,
      (SELECT COUNT(*) FROM stock_movements m WHERE m.product_id = ci.product_id AND m.reference = ?) AS already_reversed
    FROM cycle_count_items ci
    WHERE ci.session_id = ? AND ci.counted_qty = 0 AND ci.variance != 0 AND ci.product_id IS NOT NULL
      ${withImported ? '' : `AND NOT EXISTS (SELECT 1 FROM cycle_count_upload_lines l JOIN cycle_count_uploads u ON u.id = l.upload_id
                      WHERE l.item_id = ci.id AND u.undone_at IS NULL)`}
    ORDER BY ci.product_name`,
    args: [s.branch_id, s.committed_at,
      ...branchArg, s.committed_at, `${sessionNumber}%`,
      ...branchArg, s.committed_at, `${sessionNumber}%`,
      ...branchArg, s.committed_at, `${sessionNumber}%`,
      reverseRef, s.id] });

  const picked = lines.filter(l => (!onlyPrev || l.prev_counted != null)
    && (!skus || skus.includes(String(l.sku || '').toLowerCase()))
    && !exclude.includes(String(l.sku || '').toLowerCase()));
  const done = picked.filter(l => Number(l.already_reversed));
  const todo = picked.filter(l => !Number(l.already_reversed) && (adjustedMode ? Number(l.later_count) > 0 : !Number(l.later_count)));
  const skippedAdj = adjustedMode ? [] : picked.filter(l => !Number(l.already_reversed) && Number(l.later_count));

  console.log(`\n${sessionNumber} (committed ${s.committed_at} UTC, branch ${s.branch_id ?? 'all'}): ${lines.length} ${withImported ? 'lines counted 0 (checkbox or imported)' : 'zero-filled lines'} with a variance.`);
  console.log(`  ${done.length} already restored, ${todo.length} to restore${adjustedMode ? ' (adjusted by hand since)' : ''}${skippedAdj.length ? `, ${skippedAdj.length} skipped — adjusted by hand since (see --adjusted)` : ''}.\n`);

  const plan = todo.map(l => {
    const undoZero = -Number(l.variance), undoHand = adjustedMode ? -Number(l.later_sum) : 0;
    return { l, undoZero, undoHand, add: undoZero + undoHand };
  });
  if (adjustedMode) {
    for (const { l, undoZero, undoHand, add } of plan) {
      const bn = Number(l.branch_now ?? 0);
      console.log(`${l.sku}  ${l.product_name}${l.bin_code ? `  [bin ${l.bin_code}]` : ''}`);
      console.log(`   on hand before ${sessionNumber}: ${l.expected_at_count ?? '?'}   earlier count: ${l.prev_counted ?? '—'}   zeroed by: ${l.variance}`);
      console.log(`   adjusted by hand since: ${l.later_list}`);
      console.log(`   now ${bn} → ${bn + add}   (undo zeroing ${undoZero >= 0 ? '+' : ''}${undoZero}, undo hand adjustments ${undoHand >= 0 ? '+' : ''}${undoHand})\n`);
    }
  } else {
    console.log('SKU\tName\tBin\tZeroed by\tRestore +\tBranch now→after\tEarlier count\tFrom upload');
    for (const { l, add } of plan) {
      const bn = Number(l.branch_now ?? 0);
      console.log([l.sku, l.product_name, l.bin_code || '', l.variance, add, `${bn}→${bn + add}`, l.prev_counted ?? '—', l.from_uploads || 'checkbox'].join('\t'));
    }
    if (skippedAdj.length) {
      console.log('\nSkipped — adjusted by hand after the commit:');
      for (const l of skippedAdj) console.log(`  ${l.sku}\t${l.product_name}\t${l.later_list}`);
    }
  }
  if (!apply) { console.log('\nDry run — nothing changed. Re-run with --apply to make these adjustments.'); return; }

  const stmts = [];
  for (const { l, undoZero, undoHand, add } of plan) {
    if (!add) continue;
    stmts.push({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [add, l.product_id] });
    if (s.branch_id) stmts.push({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [add, l.product_id, s.branch_id] });
    // The zeroing hit the line's own bin; hand adjustments moved the branch's primary bin (lib/binSync.js).
    if (l.bin_id) stmts.push({ sql: 'UPDATE product_bin_assignments SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND bin_id = ?', args: [undoZero, l.product_id, l.bin_id] });
    if (undoHand && s.branch_id) stmts.push({ sql: `UPDATE product_bin_assignments SET quantity = MAX(0, quantity + ?), updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM product_bin_assignments WHERE product_id = ? AND branch_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1)`, args: [undoHand, l.product_id, s.branch_id] });
    stmts.push({ sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)',
      args: [l.product_id, s.branch_id || null, add, 'adjustment', reverseRef,
        `Reversal of ${sessionNumber}: line was not counted, wrongly set to 0${l.from_uploads ? ` (upload ${l.from_uploads})` : ''}${undoHand ? `; also undoes hand adjustments since (${undoHand > 0 ? '+' : ''}${undoHand})` : ''}`] });
  }
  if (!stmts.length) { console.log('Nothing to apply.'); return; }
  await db.batch(stmts, 'write'); // one atomic transaction
  console.log(`\nApplied: ${plan.filter(p => p.add).length} item(s) restored (reference ${reverseRef}).`);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
