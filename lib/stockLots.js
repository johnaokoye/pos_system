// Stock receipts ("lots") under the branch quantity, for consignment.
//
// branch_inventory.stock_qty stays the one physical figure every screen
// reads. Underneath it, once consignment tracking has started
// (settings.consignment_go_live), each receipt of stock at a branch is a lot:
// who owns it — 'owned' (Total Tools) or 'consignment' (a supplier, under an
// agreement) — when and on what document it was received, and how much of it
// is still on hand / reserved. The POS sells oldest receipt first across both
// kinds (decision A1: tie → receipt number), keeping the supplier and
// agreement against what it took.
//
// Starting tracking makes one opening 'owned' lot per branch_inventory row
// with stock, dated go-live, so stock already on hand sells before anything
// received later. Owned receipts after that (PO receipts, receipts without a
// PO) add their own lots; a Consignment GRN adds a consignment lot.
//
// Every change is logged in stock_lot_moves.

const round3 = n => Math.round((Number(n) || 0) * 1000) / 1000;

async function goLive(executor) {
  const { rows: [r] } = await executor.execute({ sql: "SELECT value FROM settings WHERE key = 'consignment_go_live'", args: [] });
  return r && r.value ? r.value : null;
}

async function addLot(executor, { product_id, branch_id, owner = 'owned', supplier_id = null, agreement_id = null, source_type, source_id = null, source_number = null, qty, unit_cost = null, received_at = null, employee_id = null }) {
  const q = round3(qty);
  if (!(q > 0) || !product_id || !branch_id) return null;
  const r = await executor.execute({
    sql: `INSERT INTO stock_lots (product_id, branch_id, owner, supplier_id, agreement_id, source_type, source_id, source_number, received_at, qty_received, qty_on_hand, unit_cost)
          VALUES (?,?,?,?,?,?,?,?,COALESCE(?, CURRENT_TIMESTAMP),?,?,?)`,
    args: [product_id, branch_id, owner, supplier_id, agreement_id, source_type, source_id, source_number, received_at, q, q, unit_cost],
  });
  const lotId = Number(r.lastInsertRowid);
  await executor.execute({ sql: 'INSERT INTO stock_lot_moves (lot_id, qty_change, kind, reference, created_by) VALUES (?,?,?,?,?)', args: [lotId, q, source_type, source_number, employee_id] });
  return lotId;
}

// An owned receipt (PO receipt, receipt without a PO…): only once tracking has started.
async function addOwnedLot(executor, args) {
  if (!(await goLive(executor))) return null;
  return addLot(executor, { ...args, owner: 'owned' });
}

// Starts tracking: one opening owned lot per branch stock row, dated now.
// Refused if it has already started.
// Consignment is being built in phases; until the POS sells from stock
// receipts (Phase 2), starting tracking anywhere but a server run with
// CONSIGNMENT_ENABLED=1 (the test server) would let supplier-owned stock be
// sold without being recorded — so it's refused.
const consignmentEnabled = () => process.env.CONSIGNMENT_ENABLED === '1';

async function startTracking(executor, employeeId) {
  if (!consignmentEnabled()) throw Object.assign(new Error("Consignment isn't switched on for this system yet — it's still being built and tested"), { status: 400 });
  if (await goLive(executor)) throw Object.assign(new Error('Consignment tracking has already started'), { status: 400 });
  const { rows } = await executor.execute({
    sql: `SELECT bi.product_id, bi.branch_id, bi.stock_qty FROM branch_inventory bi JOIN products p ON p.id = bi.product_id
          WHERE bi.stock_qty > 0 AND COALESCE(p.is_rental, 0) = 0 AND COALESCE(p.is_service, 0) = 0 AND COALESCE(p.is_non_inventory, 0) = 0`,
    args: [],
  });
  const { rows: [{ now }] } = await executor.execute({ sql: 'SELECT CURRENT_TIMESTAMP AS now', args: [] });
  for (const r of rows) {
    await addLot(executor, { product_id: r.product_id, branch_id: r.branch_id, owner: 'owned', source_type: 'opening', source_number: 'OPENING', qty: r.stock_qty, received_at: now, employee_id: employeeId });
  }
  await executor.execute({ sql: "INSERT INTO settings (key, value) VALUES ('consignment_go_live', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [now] });
  return { go_live: now, lots: rows.length };
}

// What's on hand by owner at a branch for an item (or every item), for screens.
async function lotsOnHand(executor, { product_id = null, branch_id = null } = {}) {
  const where = ['l.qty_on_hand > 0'];
  const args = [];
  if (product_id) { where.push('l.product_id = ?'); args.push(product_id); }
  if (branch_id) { where.push('l.branch_id = ?'); args.push(branch_id); }
  const { rows } = await executor.execute({
    sql: `SELECT l.*, s.name AS supplier_name, a.agreement_number, b.name AS branch_name, p.name AS product_name, p.sku
          FROM stock_lots l LEFT JOIN suppliers s ON s.id = l.supplier_id LEFT JOIN consignment_agreements a ON a.id = l.agreement_id
          LEFT JOIN branches b ON b.id = l.branch_id JOIN products p ON p.id = l.product_id
          WHERE ${where.join(' AND ')} ORDER BY l.received_at, l.source_number, l.id`,
    args,
  });
  return rows;
}

module.exports = { goLive, addLot, addOwnedLot, startTracking, lotsOnHand, round3, consignmentEnabled };
