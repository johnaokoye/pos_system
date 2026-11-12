// Sold now, collected later: POS lines the selling branch is short of, filled
// from another branch on a transfer request (POS "Get from another branch",
// permission pos_request_transfer).
//
// The sale is a normal completed sale — paid, charged to the account or by
// bank transfer, invoiced — but transfer_qty stock units of such a line come
// from transfer_from_branch_id. Stock (the selling branch's and the overall
// products.stock_qty, kept equal to the branches added up): only the part the
// selling branch had comes off at the sale; the rest stays where it is until
// it arrives on the transfer, and comes off then (arrive()), straight after
// the receive adds it, so it never shows as stock anyone else could sell.
// Each source branch gets one transfer request (status 'requested', linked by
// branch_transfers.transaction_id) that the inventory team sends as usual.
// transactions.collection_status: awaiting_transfer until every line's
// transfer_received_qty reaches its transfer_qty, then ready (staff contact
// the customer), then collected when it's handed over.

const { nextNumber } = require('./nextNumber');
const { createTransfer } = require('./transfers');
const { syncBinQty } = require('./binSync');
const { takeFromLots, recordSaleAllocation, reserveForTransfer } = require('./stockLots');
const { storeToday } = require('./storeTime');

const round3 = n => Math.round((Number(n) || 0) * 1000) / 1000;

// Checks a POS line asking for transfer from another branch. `stockUnits` is
// the line's quantity in stock units. Returns { from, qty } or null for an
// ordinary line; throws with a message for anything not allowed.
async function transferLine(db, { item, product, variation, unit, stockUnits, branchId, serialNumber, spRental }) {
  const from = item.transfer_from_branch_id ? Number(item.transfer_from_branch_id) : null;
  if (!from) return null;
  const name = product?.name || 'This item';
  if (!product || variation || serialNumber || spRental || product.is_service || product.is_rental || product.is_non_inventory) {
    throw new Error(`${name} can't come from another branch — only a stocked inventory item can`);
  }
  if (!branchId) throw new Error('Choose the branch selling this before getting items from another branch');
  if (from === Number(branchId)) throw new Error(`${name} is already at this branch — choose another branch to get it from`);
  const qty = round3(item.transfer_qty);
  if (!(qty > 0) || qty > stockUnits + 1e-9) throw new Error(`Enter how many of ${name} come from the other branch (up to ${stockUnits})`);
  if (!Number.isInteger(qty)) throw new Error(`${name} comes from another branch in whole ${unit?.sell_unit || 'unit'}s — transfers move whole stock units`);
  const { rows: [src] } = await db.execute({
    sql: `SELECT b.name, b.active, COALESCE(bi.stock_qty, 0) AS stock_qty FROM branches b
          LEFT JOIN branch_inventory bi ON bi.branch_id = b.id AND bi.product_id = ? WHERE b.id = ?`,
    args: [product.id, from],
  });
  if (!src || !src.active) throw new Error(`The branch to get ${name} from isn't an active branch`);
  if (Number(src.stock_qty) + 1e-9 < qty) throw new Error(`${src.name} only has ${Number(src.stock_qty)} of ${name} — choose fewer, or another branch`);
  return { from, qty };
}

// Inside the sale's write transaction: one transfer request per source branch
// for the sale's transfer lines. Returns [{ id, transfer_number, from }].
async function raiseSaleTransfers(tx, { transactionId, transactionNumber, branchId, employeeId, lines }) {
  const bySource = new Map();
  for (const l of lines) {
    const list = bySource.get(l.from) || [];
    const same = list.find(x => x.product_id === l.product_id);
    if (same) same.quantity += l.qty; else list.push({ product_id: l.product_id, quantity: l.qty });
    bySource.set(l.from, list);
  }
  const made = [];
  for (const [from, items] of bySource) {
    const transfer_number = await nextNumber(tx, 'branch_transfers', 'transfer_number', 'TRF-', 6);
    const id = await createTransfer(tx, {
      transfer_number, from_branch_id: from, to_branch_id: branchId, employee_id: employeeId, items, request: true,
      notes: `For sale ${transactionNumber} — the customer has paid and collects at this branch`,
    });
    await tx.execute({ sql: 'UPDATE branch_transfers SET transaction_id = ? WHERE id = ?', args: [transactionId, id] });
    // The sending branch's stock is held for the customer from now until it's
    // sent or the request is cancelled (decision A5).
    for (const it of items) await reserveForTransfer(tx, { transfer_id: id, product_id: it.product_id, branch_id: from, qty: it.quantity });
    made.push({ id, transfer_number, from });
  }
  return made;
}

// Recomputes a sale's collection_status from its lines (never undoes
// 'collected'). Returns the status.
async function refreshFulfillment(executor, transactionId) {
  const { rows: [t] } = await executor.execute({ sql: 'SELECT collection_status, ready_at FROM transactions WHERE id = ?', args: [transactionId] });
  if (!t || !t.collection_status || t.collection_status === 'collected') return t?.collection_status || null;
  const { rows: [o] } = await executor.execute({
    sql: 'SELECT COUNT(*) AS n FROM transaction_items WHERE transaction_id = ? AND COALESCE(transfer_qty, 0) - transfer_received_qty > 0.0005',
    args: [transactionId],
  });
  const status = Number(o.n) > 0 ? 'awaiting_transfer' : 'ready';
  if (status !== t.collection_status) {
    await executor.execute({ sql: `UPDATE transactions SET collection_status = ?, ready_at = ${status === 'ready' ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`, args: [status, transactionId] });
  }
  return status;
}

// Inside a transfer receive: `qty` of `productId` arrived at the selling
// branch on a transfer linked to a sale. Takes what the sale is still owed
// off that branch again (it's the customer's) and records it on the lines.
// Returns how much was taken.
async function arrive(tx, transfer, productId, qty) {
  if (!transfer.transaction_id) return 0;
  const { rows: [sale] } = await tx.execute({ sql: 'SELECT status FROM transactions WHERE id = ?', args: [transfer.transaction_id] });
  if (!sale || sale.status !== 'completed') return 0;
  const { rows: lines } = await tx.execute({
    sql: `SELECT id, transfer_qty, transfer_received_qty FROM transaction_items
          WHERE transaction_id = ? AND product_id = ? AND transfer_from_branch_id = ? AND COALESCE(transfer_qty, 0) - transfer_received_qty > 0.0005 ORDER BY id`,
    args: [transfer.transaction_id, productId, transfer.from_branch_id],
  });
  let left = qty, taken = 0;
  const { rows: [{ transaction_number: saleNumber } = {}] } = await tx.execute({ sql: 'SELECT transaction_number FROM transactions WHERE id = ?', args: [transfer.transaction_id] });
  const { rows: [{ cost: itemCost } = {}] } = await tx.execute({ sql: 'SELECT cost FROM products WHERE id = ?', args: [productId] });
  for (const l of lines) {
    if (left <= 0) break;
    const take = Math.min(left, round3(l.transfer_qty - l.transfer_received_qty));
    await tx.execute({ sql: 'UPDATE transaction_items SET transfer_received_qty = transfer_received_qty + ? WHERE id = ?', args: [take, l.id] });
    await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [take, productId, transfer.to_branch_id] });
    await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [take, productId] });
    await syncBinQty(tx, productId, transfer.to_branch_id, -take);
    // The customer's: the units this transfer brought in, with their
    // supplier and agreement, recorded against the sale line (the sale
    // qualifies now, so it's owed at today's agreed cost, A8).
    const parts = await takeFromLots(tx, { product_id: productId, branch_id: transfer.to_branch_id, qty: take, kind: 'sale', reference: saleNumber, prefer: { source_type: 'transfer_in', source_id: transfer.id } });
    if (parts.length) await recordSaleAllocation(tx, { transaction_id: transfer.transaction_id, transaction_item_id: l.id, product_id: productId, branch_id: transfer.to_branch_id, parts, day: storeToday(), owned_cost: itemCost });
    left -= take; taken += take;
  }
  if (taken > 0) await refreshFulfillment(tx, transfer.transaction_id);
  return taken;
}

// What a sale's lines are owed but won't get from the transfers raised for
// them: for each line, still owed (transfer_qty − received) less what's still
// on its way from that branch — a request not sent yet counts what was asked,
// a sent one what was sent, less what's been received; a cancelled or fully
// received transfer brings nothing more. lines: [{ id, product_id,
// transfer_from_branch_id, transfer_qty, transfer_received_qty }];
// transfers: [{ from_branch_id, status, items: [{ product_id, asked, sent,
// received }] }]. Returns [{ id, short }] for the lines short.
function shortfalls(lines, transfers) {
  const coming = new Map(); // `${from}:${product}` -> qty still on its way
  for (const t of transfers) {
    for (const i of t.items || []) {
      const left = t.status === 'requested' ? (Number(i.asked ?? i.sent) || 0) - (Number(i.received) || 0)
        : ['pending', 'in_transit'].includes(t.status) ? (Number(i.sent) || 0) - (Number(i.received) || 0) : 0;
      const key = `${t.from_branch_id}:${i.product_id}`;
      coming.set(key, (coming.get(key) || 0) + Math.max(0, left));
    }
  }
  const out = [];
  for (const l of lines) {
    const owed = stillOwed(l);
    if (owed <= 0) continue;
    const key = `${l.transfer_from_branch_id}:${l.product_id}`;
    const covered = Math.min(owed, coming.get(key) || 0);
    coming.set(key, (coming.get(key) || 0) - covered);
    const short = round3(owed - covered);
    if (short > 0) out.push({ id: l.id, short });
  }
  return out;
}

// How much of a line hasn't arrived yet — never taken off stock, so a void or
// return mustn't put it back.
function stillOwed(item) {
  return Math.max(0, round3((Number(item.transfer_qty) || 0) - (Number(item.transfer_received_qty) || 0)));
}

// Per line of a collect-later sale, in stock units: sold, returned,
// handed over, still due (sold − returned − handed over) and what can be
// handed over now (what's at the branch: everything but the part still on
// its way). lines: transaction_items rows.
async function collectionState(executor, transactionId) {
  const { rows } = await executor.execute({
    sql: `SELECT ti.id, ti.product_name, ti.quantity, ti.units_per, COALESCE(ti.transfer_qty, 0) AS transfer_qty, COALESCE(ti.transfer_received_qty, 0) AS transfer_received_qty,
            COALESCE((SELECT SUM(ri.quantity) FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE ri.transaction_item_id = ti.id AND COALESCE(r.status, '') != 'cancelled'), 0) AS returned,
            COALESCE((SELECT SUM(ci.qty) FROM collection_issues ci WHERE ci.transaction_item_id = ti.id), 0) AS issued
          FROM transaction_items ti WHERE ti.transaction_id = ? AND ti.product_id IS NOT NULL AND COALESCE(ti.is_comment, 0) = 0 ORDER BY ti.id`,
    args: [transactionId],
  });
  return rows.map(l => {
    const per = Number(l.units_per) || 1;
    const sold = round3(l.quantity * per);
    const returned = round3(l.returned * per);
    const issued = round3(l.issued);
    const onItsWay = round3(Math.max(0, l.transfer_qty - l.transfer_received_qty));
    const due = round3(Math.max(0, sold - returned - issued));
    return { id: l.id, product_name: l.product_name, sold, returned, issued, due, on_its_way: onItsWay, available_now: round3(Math.max(0, Math.min(due, sold - returned - onItsWay - issued))) };
  });
}

// Records a handover: items [{ transaction_item_id, quantity }] (stock
// units), each no more than can be handed over now. Same issue_key again =
// already recorded (returns { duplicate: true }). Marks the sale collected
// once nothing is still due.
async function issueCollection(executor, { transactionId, items, issueKey = null, note = null, employeeId = null }) {
  const { rows: [t] } = await executor.execute({ sql: 'SELECT status, collection_status FROM transactions WHERE id = ?', args: [transactionId] });
  if (!t || t.status !== 'completed' || !t.collection_status) throw Object.assign(new Error("That sale isn't waiting to be collected"), { status: 400 });
  if (t.collection_status === 'collected') throw Object.assign(new Error('Already handed over'), { status: 400 });
  if (issueKey) {
    const { rows: [dup] } = await executor.execute({ sql: 'SELECT id FROM collection_issues WHERE transaction_id = ? AND issue_key = ? LIMIT 1', args: [transactionId, issueKey] });
    if (dup) return { duplicate: true };
  }
  const state = await collectionState(executor, transactionId);
  const wanted = (items || []).map(i => ({ id: Number(i.transaction_item_id), qty: round3(i.quantity) })).filter(i => i.qty > 0);
  if (!wanted.length) throw Object.assign(new Error('Enter how many of at least one item are being handed over'), { status: 400 });
  for (const w of wanted) {
    const l = state.find(x => x.id === w.id);
    if (!l) throw Object.assign(new Error("An item isn't on this sale"), { status: 400 });
    if (w.qty - l.available_now > 0.0005) throw Object.assign(new Error(`Only ${l.available_now} of ${l.product_name} can be handed over now${l.on_its_way > 0 ? ` (${l.on_its_way} still on its way)` : ''}`), { status: 400 });
  }
  for (const w of wanted) {
    await executor.execute({ sql: 'INSERT INTO collection_issues (transaction_id, transaction_item_id, qty, issue_key, note, issued_by) VALUES (?,?,?,?,?,?)', args: [transactionId, w.id, w.qty, issueKey, note, employeeId] });
  }
  const after = await collectionState(executor, transactionId);
  const done = after.every(l => l.due <= 0.0005);
  if (done) await executor.execute({ sql: "UPDATE transactions SET collection_status = 'collected', collected_at = CURRENT_TIMESTAMP, collected_by = ? WHERE id = ?", args: [employeeId, transactionId] });
  return { duplicate: false, collected: done, lines: after };
}

module.exports = {
  collectionState, issueCollection, transferLine, raiseSaleTransfers, refreshFulfillment, arrive, stillOwed, shortfalls };
