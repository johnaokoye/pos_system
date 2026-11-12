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

// ── Taking stock out and putting it back ──────────────────────────────
// Every function below is a no-op until tracking has started.

async function moveLot(executor, lotId, change, kind, reference, employeeId) {
  await executor.execute({ sql: 'UPDATE stock_lots SET qty_on_hand = qty_on_hand + ? WHERE id = ?', args: [change, lotId] });
  await executor.execute({ sql: 'INSERT INTO stock_lot_moves (lot_id, qty_change, kind, reference, created_by) VALUES (?,?,?,?,?)', args: [lotId, change, kind, reference || null, employeeId || null] });
}

const LOT_ORDER = 'ORDER BY received_at, source_number, id';

async function branchQty(executor, productId, branchId) {
  const { rows: [r] } = await executor.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [productId, branchId] });
  return Number(r?.stock_qty) || 0;
}
async function lotsTotal(executor, productId, branchId) {
  const { rows: [r] } = await executor.execute({ sql: 'SELECT COALESCE(SUM(qty_on_hand), 0) AS q FROM stock_lots WHERE product_id = ? AND branch_id = ?', args: [productId, branchId] });
  return round3(r.q);
}

// Keeps the receipts at a branch in step with its stock figure (plus
// `offset`, for a caller that has already taken stock off the branch and is
// about to allocate it). Used after any stock change that isn't a sale,
// return or transfer — adjustments, counts, damage, shop use, layaways,
// work orders — and before every allocation, so a change made anywhere not
// yet recorded is caught and labelled rather than left to drift.
// More stock than receipts: a dated owned receipt (`kind`). Less: taken off
// Total Tools-owned receipts first, newest first, then supplier-owned ones
// oldest first — each logged as `kind`, so the month-end reconciliation sees
// any supplier-owned stock that went other than by sale. Returns the parts
// taken: [{ lot_id, owner, supplier_id, agreement_id, qty }].
// `use: 'shop_use'` (decision A4): supplier-owned receipts are only used
// where the agreement allows shop use; if what's left can't cover it, the
// change is refused (status 400) and rolls back.
async function syncToBranch(executor, { product_id, branch_id, kind = 'unrecorded change', reference = null, employee_id = null, offset = 0, use = null }) {
  if (!product_id || !branch_id || !(await goLive(executor))) return [];
  const target = round3((await branchQty(executor, product_id, branch_id)) + offset);
  const have = await lotsTotal(executor, product_id, branch_id);
  let diff = round3(target - have);
  if (Math.abs(diff) < 0.0005) return [];
  if (diff > 0) {
    await addLot(executor, { product_id, branch_id, owner: 'owned', source_type: kind, source_number: reference, qty: diff, employee_id });
    return [];
  }
  let need = -diff;
  const taken = [];
  const { rows: owned } = await executor.execute({ sql: "SELECT * FROM stock_lots WHERE product_id = ? AND branch_id = ? AND owner = 'owned' AND qty_on_hand > 0 ORDER BY received_at DESC, id DESC", args: [product_id, branch_id] });
  const allowed = use === 'shop_use' ? ' AND agreement_id IN (SELECT id FROM consignment_agreements WHERE allow_shop_use = 1)' : '';
  const { rows: consigned } = await executor.execute({ sql: `SELECT * FROM stock_lots WHERE product_id = ? AND branch_id = ? AND owner = 'consignment' AND qty_on_hand > 0${allowed} ${LOT_ORDER}`, args: [product_id, branch_id] });
  for (const l of [...owned, ...consigned]) {
    if (need <= 0.0005) break;
    const free = round3(l.qty_on_hand - (l.qty_reserved || 0));
    const take = round3(Math.min(need, free > 0 ? free : 0));
    if (take <= 0) continue;
    await moveLot(executor, l.id, -take, kind, reference, employee_id);
    taken.push({ lot_id: l.id, owner: l.owner, supplier_id: l.supplier_id, agreement_id: l.agreement_id, qty: take });
    need = round3(need - take);
  }
  // Only reserved stock left: take it, and the reservation goes with it.
  // (Not for a restricted use — reserved stock is a customer's.)
  if (use && need > 0.0005) {
    const { rows: [p] } = await executor.execute({ sql: 'SELECT name FROM products WHERE id = ?', args: [product_id] });
    throw Object.assign(new Error(`Not enough of ${p?.name || 'this item'} can go to ${use === 'shop_use' ? 'shop use' : use}: the rest is supplier-owned (consignment) stock whose agreement doesn't allow it`), { status: 400 });
  }
  for (const l of [...owned, ...consigned]) {
    if (need <= 0.0005) break;
    const { rows: [cur] } = await executor.execute({ sql: 'SELECT qty_on_hand, qty_reserved FROM stock_lots WHERE id = ?', args: [l.id] });
    const take = round3(Math.min(need, cur.qty_on_hand));
    if (take <= 0) continue;
    await moveLot(executor, l.id, -take, kind, reference, employee_id);
    await executor.execute({ sql: 'UPDATE stock_lots SET qty_reserved = MAX(0, MIN(qty_reserved, qty_on_hand)) WHERE id = ?', args: [l.id] });
    taken.push({ lot_id: l.id, owner: l.owner, supplier_id: l.supplier_id, agreement_id: l.agreement_id, qty: take });
    need = round3(need - take);
  }
  return taken;
}

// Takes `qty` stock units that have just come off the branch (call it after
// the branch figure has gone down) from the receipts, oldest receipt first
// across owned and supplier-owned stock (A1), what isn't reserved before
// what is. Anything the receipts can't cover (stock sold into the negative)
// is an owned part with no receipt. Returns the parts:
// [{ lot_id, owner, supplier_id, agreement_id, unit_cost, received_at, qty }].
// `prefer` ({ source_type, source_id }) takes those receipts first — the
// units a transfer just brought in for a customer's order are the ones the
// customer gets.
// `use: 'work_order'` (A4): supplier-owned receipts only where the agreement
// allows work-order use; if the rest can't cover it, refused (status 400).
async function takeFromLots(executor, { product_id, branch_id, qty, kind, reference = null, employee_id = null, prefer = null, use = null }) {
  const q = round3(qty);
  if (!(q > 0) || !product_id || !branch_id || !(await goLive(executor))) return [];
  // Catch anything changed without being recorded, as it stood before this.
  await syncToBranch(executor, { product_id, branch_id, offset: q, employee_id });
  const { rows: all } = await executor.execute({ sql: `SELECT * FROM stock_lots WHERE product_id = ? AND branch_id = ? AND qty_on_hand > 0 ${LOT_ORDER}`, args: [product_id, branch_id] });
  const preferred = l => prefer && l.source_type === prefer.source_type && Number(l.source_id) === Number(prefer.source_id);
  let usable = all;
  if (use === 'work_order') {
    const { rows: ok } = await executor.execute({ sql: 'SELECT id FROM consignment_agreements WHERE allow_work_orders = 1', args: [] });
    const allowed = new Set(ok.map(r => Number(r.id)));
    usable = all.filter(l => l.owner === 'owned' || allowed.has(Number(l.agreement_id)));
    const free = round3(usable.reduce((t, l) => t + l.qty_on_hand - (l.qty_reserved || 0), 0));
    if (free + 0.0005 < q) {
      const { rows: [p] } = await executor.execute({ sql: 'SELECT name FROM products WHERE id = ?', args: [product_id] });
      throw Object.assign(new Error(`Only ${Math.max(0, free)} of ${p?.name || 'this item'} can go on a work order here: the rest is reserved or supplier-owned (consignment) stock whose agreement doesn't allow work-order use`), { status: 400 });
    }
  }
  const lots = [...usable.filter(preferred), ...usable.filter(l => !preferred(l))];
  let need = q;
  const parts = [];
  const take = async (l, n) => {
    await moveLot(executor, l.id, -n, kind, reference, employee_id);
    parts.push({ lot_id: l.id, owner: l.owner, supplier_id: l.supplier_id, agreement_id: l.agreement_id, unit_cost: l.unit_cost, received_at: l.received_at, qty: n });
    l.qty_on_hand = round3(l.qty_on_hand - n);
    need = round3(need - n);
  };
  for (const l of lots) {
    if (need <= 0.0005) break;
    const free = round3(l.qty_on_hand - (l.qty_reserved || 0));
    if (free > 0) await take(l, round3(Math.min(need, free)));
  }
  for (const l of lots) {
    if (need <= 0.0005) break;
    if (l.qty_on_hand > 0) {
      const n = round3(Math.min(need, l.qty_on_hand));
      await take(l, n);
      await executor.execute({ sql: 'UPDATE stock_lots SET qty_reserved = MAX(0, MIN(qty_reserved, qty_on_hand)) WHERE id = ?', args: [l.id] });
    }
  }
  if (need > 0.0005) parts.push({ lot_id: null, owner: 'owned', supplier_id: null, agreement_id: null, unit_cost: null, received_at: null, qty: need });
  return parts;
}

// Puts quantity back on a receipt (a return or void puts it back where it
// came from); a part with no receipt goes on a new owned one.
async function putBackOnLot(executor, { lot_id, product_id, branch_id, qty, kind, reference = null, employee_id = null }) {
  const q = round3(qty);
  if (!(q > 0) || !(await goLive(executor))) return;
  if (lot_id) {
    const { rows: [l] } = await executor.execute({ sql: 'SELECT id FROM stock_lots WHERE id = ?', args: [lot_id] });
    if (l) { await moveLot(executor, lot_id, q, kind, reference, employee_id); return; }
  }
  await addLot(executor, { product_id, branch_id, owner: 'owned', source_type: kind, source_number: reference, qty: q, employee_id });
}

// The agreed cost in effect on `day` for an item on an agreement (A8).
async function costOn(executor, agreementId, productId, day) {
  const { rows: [r] } = await executor.execute({
    sql: `SELECT c.cost, c.effective_from FROM consignment_agreement_costs c JOIN consignment_agreement_items i ON i.id = c.agreement_item_id
          WHERE i.agreement_id = ? AND i.product_id = ? AND c.effective_from <= ? ORDER BY c.effective_from DESC, c.id DESC LIMIT 1`,
    args: [agreementId, productId, day],
  });
  return r ? { cost: Number(r.cost), effective_from: r.effective_from } : null;
}

// ── Sales ──
// Records a sale line's allocation: owned parts at the item's cost,
// supplier-owned at the agreed cost in effect on `day` (A8).
async function recordSaleAllocation(executor, { transaction_id, transaction_item_id, product_id, branch_id, parts, day, owned_cost = null }) {
  for (const p of parts) {
    let cost = owned_cost;
    if (p.owner === 'consignment') cost = (await costOn(executor, p.agreement_id, product_id, day))?.cost ?? p.unit_cost ?? null;
    await executor.execute({
      sql: `INSERT INTO sale_lot_allocations (transaction_id, transaction_item_id, product_id, branch_id, lot_id, owner, supplier_id, agreement_id, qty, unit_cost, qualified_on)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [transaction_id, transaction_item_id, product_id, branch_id, p.lot_id, p.owner, p.supplier_id, p.agreement_id, p.qty, cost, day],
    });
  }
}

// Takes `qty` stock units of a sale line's allocation back — latest part
// first — onto the receipts they came from, logging each against the
// supplier's settlement (stock_lot_returns). Returns what it put back.
async function returnSaleAllocation(executor, { transaction_item_id, product_id, branch_id, qty, kind, reference = null, return_id = null, goods_condition = null, employee_id = null }) {
  let left = round3(qty);
  if (!(left > 0) || !(await goLive(executor))) return [];
  const { rows } = await executor.execute({ sql: 'SELECT * FROM sale_lot_allocations WHERE transaction_item_id = ? AND qty - returned_qty > 0 ORDER BY id DESC', args: [transaction_item_id] });
  const back = [];
  for (const a of rows) {
    if (left <= 0.0005) break;
    const n = round3(Math.min(left, a.qty - a.returned_qty));
    await executor.execute({ sql: 'UPDATE sale_lot_allocations SET returned_qty = returned_qty + ? WHERE id = ?', args: [n, a.id] });
    await executor.execute({ sql: 'INSERT INTO stock_lot_returns (allocation_id, return_id, kind, qty, goods_condition) VALUES (?,?,?,?,?)', args: [a.id, return_id, kind, n, goods_condition] });
    await putBackOnLot(executor, { lot_id: a.lot_id, product_id: a.product_id, branch_id: a.branch_id, qty: n, kind, reference, employee_id });
    back.push({ allocation_id: a.id, owner: a.owner, supplier_id: a.supplier_id, agreement_id: a.agreement_id, qty: n });
    left = round3(left - n);
  }
  // More than was allocated (sold before tracking started): owned stock.
  if (left > 0.0005 && product_id && branch_id) await putBackOnLot(executor, { lot_id: null, product_id, branch_id, qty: left, kind, reference, employee_id });
  return back;
}

// ── Layaways (A4) ──
// Made: the receipts it took, reserved for the customer, not yet billable.
async function recordLayawayAllocation(executor, { plan_id, plan_item_id, product_id, branch_id, parts }) {
  for (const p of parts) {
    await executor.execute({
      sql: 'INSERT INTO layaway_lot_allocations (plan_id, plan_item_id, product_id, branch_id, lot_id, owner, supplier_id, agreement_id, qty) VALUES (?,?,?,?,?,?,?,?,?)',
      args: [plan_id, plan_item_id, product_id, branch_id, p.lot_id, p.owner, p.supplier_id, p.agreement_id, p.qty],
    });
  }
}

// Paid off: the sale qualifies today, so supplier-owned parts become
// billable at today's agreed cost (A8); owned parts at the item's cost.
async function qualifyLayaway(executor, { plan_id, transaction_id, day }) {
  if (!(await goLive(executor))) return;
  const { rows } = await executor.execute({ sql: 'SELECT a.*, p.cost AS item_cost FROM layaway_lot_allocations a JOIN products p ON p.id = a.product_id WHERE a.plan_id = ? AND a.qualified_on IS NULL', args: [plan_id] });
  for (const a of rows) {
    const cost = a.owner === 'consignment' ? (await costOn(executor, a.agreement_id, a.product_id, day))?.cost ?? null : a.item_cost;
    await executor.execute({ sql: 'UPDATE layaway_lot_allocations SET qualified_on = ?, unit_cost = ?, transaction_id = ? WHERE id = ?', args: [day, cost, transaction_id, a.id] });
  }
}

// Cancelled: `qty` stock units of a plan line go back on the receipts they
// came from (anything it didn't record — made before tracking — as owned).
async function releaseLayawayItem(executor, { plan_item_id, product_id, branch_id, qty, reference = null, employee_id = null }) {
  let left = round3(qty);
  if (!(left > 0) || !(await goLive(executor))) return;
  const { rows } = await executor.execute({ sql: 'SELECT * FROM layaway_lot_allocations WHERE plan_item_id = ? AND qty - released_qty > 0 ORDER BY id DESC', args: [plan_item_id] });
  for (const a of rows) {
    if (left <= 0.0005) break;
    const n = round3(Math.min(left, a.qty - a.released_qty));
    await executor.execute({ sql: 'UPDATE layaway_lot_allocations SET released_qty = released_qty + ? WHERE id = ?', args: [n, a.id] });
    await putBackOnLot(executor, { lot_id: a.lot_id, product_id, branch_id, qty: n, kind: 'layaway_cancelled', reference, employee_id });
    left = round3(left - n);
  }
  if (left > 0.0005) await putBackOnLot(executor, { lot_id: null, product_id, branch_id, qty: left, kind: 'layaway_cancelled', reference, employee_id });
}

// ── Transfers ──
// Holds stock at the sending branch for a transfer request raised by a sale
// (A5): oldest receipts first, out of what can be sold elsewhere.
async function reserveForTransfer(executor, { transfer_id, product_id, branch_id, qty }) {
  let need = round3(qty);
  if (!(need > 0) || !(await goLive(executor))) return 0;
  const { rows: lots } = await executor.execute({ sql: `SELECT * FROM stock_lots WHERE product_id = ? AND branch_id = ? AND qty_on_hand - qty_reserved > 0 ${LOT_ORDER}`, args: [product_id, branch_id] });
  let held = 0;
  for (const l of lots) {
    if (need <= 0.0005) break;
    const n = round3(Math.min(need, l.qty_on_hand - l.qty_reserved));
    await executor.execute({ sql: 'UPDATE stock_lots SET qty_reserved = qty_reserved + ? WHERE id = ?', args: [n, l.id] });
    await executor.execute({ sql: 'INSERT INTO lot_reservations (lot_id, transfer_id, product_id, qty) VALUES (?,?,?,?)', args: [l.id, transfer_id, product_id, n] });
    need = round3(need - n);
    held = round3(held + n);
  }
  return held;
}

// Releases a transfer's reservations (sent, or the request cancelled).
async function releaseTransferReservations(executor, transferId) {
  const { rows } = await executor.execute({ sql: 'SELECT * FROM lot_reservations WHERE transfer_id = ? AND released_at IS NULL', args: [transferId] });
  for (const r of rows) {
    await executor.execute({ sql: 'UPDATE stock_lots SET qty_reserved = MAX(0, qty_reserved - ?) WHERE id = ?', args: [r.qty, r.lot_id] });
    await executor.execute({ sql: 'UPDATE lot_reservations SET released_at = CURRENT_TIMESTAMP WHERE id = ?', args: [r.id] });
  }
}

// Stock leaving the sending branch on a transfer (after the branch figure
// has gone down): its reservations are released, then the receipts it takes
// — oldest first — are recorded so ownership travels with the goods.
async function sendTransferLots(executor, { transfer_id, transfer_number, product_id, branch_id, qty, employee_id = null }) {
  if (!(await goLive(executor))) return;
  await releaseTransferReservations(executor, transfer_id);
  const parts = await takeFromLots(executor, { product_id, branch_id, qty, kind: 'transfer_out', reference: transfer_number, employee_id });
  for (const p of parts) {
    await executor.execute({
      sql: 'INSERT INTO transfer_lot_allocations (transfer_id, product_id, lot_id, owner, supplier_id, agreement_id, unit_cost, received_at, qty) VALUES (?,?,?,?,?,?,?,?,?)',
      args: [transfer_id, product_id, p.lot_id, p.owner, p.supplier_id, p.agreement_id, p.unit_cost, p.received_at, p.qty],
    });
  }
}

// Stock arriving at the destination (after its branch figure has gone up):
// receipts there with the same owner, supplier, agreement and cost, dated now
// (a transfer in is a receipt at that branch, A1). Whatever the transfer
// didn't record (sent before tracking started) arrives as owned stock.
async function receiveTransferLots(executor, { transfer_id, transfer_number, product_id, branch_id, qty, employee_id = null }) {
  let left = round3(qty);
  if (!(left > 0) || !(await goLive(executor))) return;
  const { rows } = await executor.execute({ sql: 'SELECT * FROM transfer_lot_allocations WHERE transfer_id = ? AND product_id = ? AND qty - received_qty - returned_qty > 0 ORDER BY id', args: [transfer_id, product_id] });
  for (const a of rows) {
    if (left <= 0.0005) break;
    const n = round3(Math.min(left, a.qty - a.received_qty - a.returned_qty));
    await executor.execute({ sql: 'UPDATE transfer_lot_allocations SET received_qty = received_qty + ? WHERE id = ?', args: [n, a.id] });
    await addLot(executor, { product_id, branch_id, owner: a.owner, supplier_id: a.supplier_id, agreement_id: a.agreement_id, source_type: 'transfer_in', source_id: transfer_id, source_number: transfer_number, qty: n, unit_cost: a.unit_cost, employee_id });
    left = round3(left - n);
  }
  if (left > 0.0005) await addLot(executor, { product_id, branch_id, owner: 'owned', source_type: 'transfer_in', source_id: transfer_id, source_number: transfer_number, qty: left, employee_id });
}

// A sent transfer cancelled: what hadn't arrived goes back on the receipts
// it left from at the sending branch.
async function returnTransferLots(executor, { transfer_id, transfer_number, product_id, branch_id, qty, employee_id = null }) {
  let left = round3(qty);
  if (!(left > 0) || !(await goLive(executor))) return;
  const { rows } = await executor.execute({ sql: 'SELECT * FROM transfer_lot_allocations WHERE transfer_id = ? AND product_id = ? AND qty - received_qty - returned_qty > 0 ORDER BY id DESC', args: [transfer_id, product_id] });
  for (const a of rows) {
    if (left <= 0.0005) break;
    const n = round3(Math.min(left, a.qty - a.received_qty - a.returned_qty));
    await executor.execute({ sql: 'UPDATE transfer_lot_allocations SET returned_qty = returned_qty + ? WHERE id = ?', args: [n, a.id] });
    await putBackOnLot(executor, { lot_id: a.lot_id, product_id, branch_id, qty: n, kind: 'transfer_cancelled', reference: transfer_number, employee_id });
    left = round3(left - n);
  }
  if (left > 0.0005) await putBackOnLot(executor, { lot_id: null, product_id, branch_id, qty: left, kind: 'transfer_cancelled', reference: transfer_number, employee_id });
}

module.exports = {
  goLive, addLot, addOwnedLot, startTracking, lotsOnHand, round3, consignmentEnabled,
  syncToBranch, takeFromLots, putBackOnLot, costOn, recordSaleAllocation, returnSaleAllocation, lotsTotal, branchQty,
  reserveForTransfer, releaseTransferReservations, sendTransferLots, receiveTransferLots, returnTransferLots,
  recordLayawayAllocation, qualifyLayaway, releaseLayawayItem,
};
