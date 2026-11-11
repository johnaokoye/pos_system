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
  for (const l of lines) {
    if (left <= 0) break;
    const take = Math.min(left, round3(l.transfer_qty - l.transfer_received_qty));
    await tx.execute({ sql: 'UPDATE transaction_items SET transfer_received_qty = transfer_received_qty + ? WHERE id = ?', args: [take, l.id] });
    left -= take; taken += take;
  }
  if (taken > 0) {
    await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [taken, productId, transfer.to_branch_id] });
    await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [taken, productId] });
    await syncBinQty(tx, productId, transfer.to_branch_id, -taken);
    await refreshFulfillment(tx, transfer.transaction_id);
  }
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

module.exports = { transferLine, raiseSaleTransfers, refreshFulfillment, arrive, stillOwed, shortfalls };
