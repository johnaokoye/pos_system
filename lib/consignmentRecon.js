// Month-end consignment reconciliation (decisions A2, A3, A6): for one
// agreement and one calendar month on the store clock (Jamaica time), per
// branch and item —
//   stock: opening, receipts (GRNs), transfers in/out, POS sales, returns &
//     voids, layaways, shop use, damage, other adjustments (counts, stock
//     adjustments, anything recorded as 'unrecorded change') → expected
//     closing; the physical count entered; the discrepancy. Plus one
//     'in_transit' line per item: supplier stock sent between branches and not
//     received by the cut-off.
//   billing, kept separate: POS-recorded sales (qualified this month, at the
//     cost saved on each sale, A8), layaways paid off this month, returns this
//     month — split into this month's sales and earlier months' (a locked
//     month stays as it was; the credit lands here, A3) — shop use the
//     agreement allowed, and shortages / damage Finance approved where the
//     agreement makes Total Tools responsible.
// Everything comes from stock_lot_moves and the sale / layaway / return
// allocation tables (lib/stockLots.js).

const { costOn, round3 } = require('./stockLots');
const { storeOffsetModifier } = require('./storeTime');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function periodBounds(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw Object.assign(new Error('Choose the month (YYYY-MM)'), { status: 400 });
  const [y, m] = period.split('-').map(Number);
  const start = `${period}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, next, last };
}

const KIND = {
  consignment_grn: 'receipts', transfer_in: 'transfers_in', transfer_out: 'transfers_out', transfer_cancelled: 'transfers_out',
  sale: 'sales', return: 'returns', void: 'returns', layaway: 'layaways', layaway_cancelled: 'layaways',
  shop_use: 'shop_use', damaged: 'damaged', work_order: 'work_orders',
};
const STOCK_COLS = ['receipts', 'transfers_in', 'transfers_out', 'sales', 'returns', 'layaways', 'work_orders', 'shop_use', 'damaged', 'adjustments'];

// Works out the lines. `kept` (Map key → { physical_count, approved_shortage_qty,
// approved_damage_qty }) carries entries over when a draft is refreshed.
async function computeLines(executor, agreement, period, kept = new Map()) {
  const { start, next, last } = periodBounds(period);
  const off = storeOffsetModifier();
  const local = col => `datetime(${col}, '${off}')`;
  const startTs = `${start} 00:00:00`, nextTs = `${next} 00:00:00`;
  const lines = new Map();
  const line = (type, branchId, productId) => {
    const key = `${type}:${branchId || ''}:${productId}`;
    if (!lines.has(key)) lines.set(key, { key, line_type: type, branch_id: branchId || null, product_id: productId, opening: 0, ...Object.fromEntries(STOCK_COLS.map(c => [c, 0])),
      in_transit: 0, pos_sales_qty: 0, pos_sales_value: 0, layaway_qty: 0, layaway_value: 0, work_order_qty: 0, work_order_value: 0, returns_qty: 0, returns_value: 0, prior_returns_qty: 0, prior_returns_value: 0,
      shop_use_value: 0, adjust_short: 0 });
    return lines.get(key);
  };

  // Stock: every move on this agreement's receipts up to the cut-off.
  const { rows: moves } = await executor.execute({
    sql: `SELECT l.branch_id, l.product_id, m.kind,
            SUM(CASE WHEN ${local('m.created_at')} < ? THEN m.qty_change ELSE 0 END) AS before,
            SUM(CASE WHEN ${local('m.created_at')} >= ? THEN m.qty_change ELSE 0 END) AS during,
            SUM(CASE WHEN ${local('m.created_at')} >= ? AND m.qty_change < 0 THEN m.qty_change ELSE 0 END) AS during_out
          FROM stock_lot_moves m JOIN stock_lots l ON l.id = m.lot_id
          WHERE l.agreement_id = ? AND l.owner = 'consignment' AND ${local('m.created_at')} < ?
          GROUP BY l.branch_id, l.product_id, m.kind`,
    args: [startTs, startTs, startTs, agreement.id, nextTs],
  });
  const transit = new Map();
  for (const mv of moves) {
    const l = line('stock', mv.branch_id, mv.product_id);
    l.opening = round3(l.opening + Number(mv.before));
    const col = KIND[mv.kind] || 'adjustments';
    l[col] = round3(l[col] + Number(mv.during));
    if (col === 'adjustments') l.adjust_short = round3(l.adjust_short - Number(mv.during_out));
    if (['transfer_out', 'transfer_in', 'transfer_cancelled'].includes(mv.kind)) {
      transit.set(mv.product_id, round3((transit.get(mv.product_id) || 0) - Number(mv.before) - Number(mv.during)));
    }
  }
  for (const [productId, q] of transit) if (q > 0.0005) line('in_transit', null, productId).in_transit = q;

  // Billing: sales and layaways that qualified this month (store-clock days).
  const { rows: sales } = await executor.execute({
    sql: `SELECT branch_id, product_id, SUM(qty) AS q, SUM(qty * COALESCE(unit_cost, 0)) AS v FROM sale_lot_allocations
          WHERE agreement_id = ? AND owner = 'consignment' AND qualified_on >= ? AND qualified_on < ? GROUP BY branch_id, product_id`,
    args: [agreement.id, start, next],
  });
  for (const r of sales) { const l = line('stock', r.branch_id, r.product_id); l.pos_sales_qty = round3(r.q); l.pos_sales_value = round2(r.v); }
  const { rows: lays } = await executor.execute({
    sql: `SELECT branch_id, product_id, SUM(qty - released_qty) AS q, SUM((qty - released_qty) * COALESCE(unit_cost, 0)) AS v FROM layaway_lot_allocations
          WHERE agreement_id = ? AND owner = 'consignment' AND qualified_on >= ? AND qualified_on < ? GROUP BY branch_id, product_id`,
    args: [agreement.id, start, next],
  });
  for (const r of lays) { const l = line('stock', r.branch_id, r.product_id); l.layaway_qty = round3(r.q); l.layaway_value = round2(r.v); }
  // Work-order parts issued this month (billable when issued, A4).
  const { rows: wos } = await executor.execute({
    sql: `SELECT branch_id, product_id, SUM(qty) AS q, SUM(qty * COALESCE(unit_cost, 0)) AS v FROM work_order_lot_allocations
          WHERE agreement_id = ? AND owner = 'consignment' AND qualified_on >= ? AND qualified_on < ? GROUP BY branch_id, product_id`,
    args: [agreement.id, start, next],
  });
  for (const r of wos) { const l = line('stock', r.branch_id, r.product_id); l.work_order_qty = round3(r.q); l.work_order_value = round2(r.v); }
  // Returns and voids made this month, at the cost saved on the sale (A8);
  // those of sales from earlier months shown apart (A3).
  const { rows: rets } = await executor.execute({
    sql: `SELECT sa.branch_id, sa.product_id, (sa.qualified_on < ?) AS prior, SUM(r.qty) AS q, SUM(r.qty * COALESCE(sa.unit_cost, 0)) AS v
          FROM stock_lot_returns r JOIN sale_lot_allocations sa ON sa.id = r.allocation_id
          WHERE sa.agreement_id = ? AND sa.owner = 'consignment' AND ${local('r.created_at')} >= ? AND ${local('r.created_at')} < ?
          GROUP BY sa.branch_id, sa.product_id, prior`,
    args: [start, agreement.id, startTs, nextTs],
  });
  for (const r of rets) {
    const l = line('stock', r.branch_id, r.product_id);
    if (Number(r.prior)) { l.prior_returns_qty = round3(l.prior_returns_qty + Number(r.q)); l.prior_returns_value = round2(l.prior_returns_value + Number(r.v)); }
    else { l.returns_qty = round3(l.returns_qty + Number(r.q)); l.returns_value = round2(l.returns_value + Number(r.v)); }
  }

  const out = [];
  for (const l of lines.values()) {
    const k = kept.get(l.key) || {};
    const cost = (await costOn(executor, agreement.id, l.product_id, last))?.cost ?? null;
    const expected = round3(l.opening + STOCK_COLS.reduce((t, c) => t + l[c], 0));
    const physical = k.physical_count != null ? Number(k.physical_count) : null;
    const discrepancy = physical == null ? 0 : round3(physical - expected);
    const shopUseQty = round3(-l.shop_use);
    const shortage = round3(l.adjust_short + Math.max(0, -discrepancy));
    const damage = round3(Math.max(0, -l.damaged));
    const approvedShort = agreement.shortage_responsibility === 'total_tools' ? Math.min(shortage, Number(k.approved_shortage_qty) || 0) : 0;
    const approvedDamage = agreement.damage_responsibility === 'total_tools' ? Math.min(damage, Number(k.approved_damage_qty) || 0) : 0;
    const shopUseValue = round2(shopUseQty * (cost || 0));
    const billableQty = round3(l.pos_sales_qty + l.layaway_qty + l.work_order_qty - l.returns_qty - l.prior_returns_qty + shopUseQty + approvedShort + approvedDamage);
    const billableValue = round2(l.pos_sales_value + l.layaway_value + l.work_order_value - l.returns_value - l.prior_returns_value + shopUseValue + (approvedShort + approvedDamage) * (cost || 0));
    const { adjust_short, key, ...rest } = l;
    out.push({
      ...rest, key, expected_closing: l.line_type === 'stock' ? expected : 0, physical_count: physical, discrepancy,
      shop_use_value: shopUseValue, shortage_qty: shortage, damage_qty: damage, approved_shortage_qty: approvedShort, approved_damage_qty: approvedDamage,
      unit_cost_end: cost, billable_qty: l.line_type === 'stock' ? billableQty : 0, billable_value: l.line_type === 'stock' ? billableValue : 0,
    });
  }
  out.sort((a, b) => (a.line_type === b.line_type ? 0 : a.line_type === 'stock' ? -1 : 1) || (a.product_id - b.product_id) || ((a.branch_id || 0) - (b.branch_id || 0)));
  return out;
}

function totalsOf(lines) {
  const cols = ['pos_sales_qty', 'pos_sales_value', 'layaway_qty', 'layaway_value', 'work_order_qty', 'work_order_value', 'returns_qty', 'returns_value', 'prior_returns_qty', 'prior_returns_value',
    'shop_use_value', 'shortage_qty', 'damage_qty', 'approved_shortage_qty', 'approved_damage_qty', 'billable_qty', 'billable_value', 'in_transit', 'expected_closing'];
  const t = {};
  for (const c of cols) t[c] = (c.endsWith('value') ? round2 : round3)(lines.reduce((s, l) => s + (Number(l[c]) || 0), 0));
  t.discrepancy_lines = lines.filter(l => Math.abs(l.discrepancy) > 0.0005).length;
  t.uncounted_lines = lines.filter(l => l.line_type === 'stock' && l.physical_count == null).length;
  return t;
}

const LINE_COLS = ['line_type', 'branch_id', 'product_id', 'opening', ...STOCK_COLS, 'expected_closing', 'physical_count', 'discrepancy', 'in_transit',
  'pos_sales_qty', 'pos_sales_value', 'layaway_qty', 'layaway_value', 'work_order_qty', 'work_order_value', 'returns_qty', 'returns_value', 'prior_returns_qty', 'prior_returns_value',
  'shop_use_value', 'shortage_qty', 'damage_qty', 'approved_shortage_qty', 'approved_damage_qty', 'unit_cost_end', 'billable_qty', 'billable_value'];

// Rewrites a draft's lines from the records, keeping counts and approvals entered.
async function writeLines(executor, recon, agreement) {
  const { rows: old } = await executor.execute({ sql: 'SELECT * FROM consignment_reconciliation_lines WHERE recon_id = ?', args: [recon.id] });
  const kept = new Map(old.map(o => [`${o.line_type}:${o.branch_id || ''}:${o.product_id}`, o]));
  const lines = await computeLines(executor, agreement, recon.period, kept);
  await executor.execute({ sql: 'DELETE FROM consignment_reconciliation_lines WHERE recon_id = ?', args: [recon.id] });
  for (const l of lines) {
    await executor.execute({
      sql: `INSERT INTO consignment_reconciliation_lines (recon_id, ${LINE_COLS.join(', ')}) VALUES (?, ${LINE_COLS.map(() => '?').join(', ')})`,
      args: [recon.id, ...LINE_COLS.map(c => l[c] ?? null)],
    });
  }
  const totals = totalsOf(lines);
  await executor.execute({ sql: 'UPDATE consignment_reconciliations SET totals_json = ?, refreshed_at = CURRENT_TIMESTAMP WHERE id = ?', args: [JSON.stringify(totals), recon.id] });
  return totals;
}

module.exports = { periodBounds, computeLines, writeLines, totalsOf };
