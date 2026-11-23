// A work order item's trip (owner's process, 2026-11-23): taken in at a store,
// sent to the Warehouse, received there (checkpoint: photos + each accessory's
// condition), sent up to the service center and received there; once the job
// is finished (complete / awaiting pickup / not worth fixing / cancelled) it
// comes back the same way — service center → Warehouse → store. A work order
// taken in at a Warehouse (branches.is_warehouse) starts and ends there.
//
// Each step is a work_order_movements row: kind 'send' (from → to, who
// carried it) or 'receive' (at to_location, linked to its send by send_id).
// The next step is worked out from the last row, never chosen freely.

const LOCATIONS = ['store', 'warehouse', 'service_center'];
const FINISHED = ['complete', 'awaiting_pickup', 'not_worth_fixing', 'cancelled'];
const CONDITIONS = ['ok', 'damaged', 'missing'];

const LOCATION_LABELS = { store: 'Store', warehouse: 'Warehouse', service_center: 'Service Center' };
const locationLabel = (loc, wo) => loc === 'store' && wo && wo.branch_name ? wo.branch_name : LOCATION_LABELS[loc] || loc;

// wo needs status, returned_to_customer_at and branch_is_warehouse; movements oldest first.
function movementState(wo, movements) {
  const home = Number(wo.branch_is_warehouse) ? 'warehouse' : 'store';
  const last = movements[movements.length - 1] || null;
  let location = home;
  let inTransit = null;
  if (last && last.kind === 'send') { location = null; inTransit = { from: last.from_location, to: last.to_location, send_id: last.id }; }
  else if (last) location = last.to_location;

  let next = null;
  const closed = wo.status === 'picked_up' || !!wo.returned_to_customer_at;
  if (inTransit) next = { kind: 'receive', from: inTransit.from, to: inTransit.to };
  else if (!closed && !FINISHED.includes(wo.status)) {
    if (location === 'store') next = { kind: 'send', from: 'store', to: 'warehouse' };
    else if (location === 'warehouse') next = { kind: 'send', from: 'warehouse', to: 'service_center' };
  } else if (!closed) {
    if (location === 'service_center') next = { kind: 'send', from: 'service_center', to: 'warehouse' };
    else if (location === 'warehouse' && home === 'store') next = { kind: 'send', from: 'warehouse', to: 'store' };
  }
  const warehouseReceived = home === 'warehouse' || movements.some(m => m.kind === 'receive' && m.to_location === 'warehouse');
  return {
    home,
    location,
    in_transit: inTransit,
    next,
    warehouse_received: warehouseReceived,
    at_home: !inTransit && location === home,
    // Assessment waits for the Warehouse checkpoint on work orders opened since tracking began
    assessment_blocked: !!Number(wo.movement_tracked) && !warehouseReceived,
  };
}

// Attach `movement` (state) to list rows with one query.
async function decorateMovements(db, rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const { rows: moves } = await db.execute({
    sql: `SELECT id, work_order_id, kind, from_location, to_location FROM work_order_movements WHERE work_order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    args: ids,
  });
  const byWo = {};
  for (const m of moves) (byWo[m.work_order_id] = byWo[m.work_order_id] || []).push(m);
  for (const r of rows) r.movement = movementState(r, byWo[r.id] || []);
  return rows;
}

const PHOTO_URL_SQL = `CASE WHEN p.stored_name LIKE 'https://%' THEN p.stored_name ELSE '/uploads/wo-photos/' || p.stored_name END`;

async function loadMovements(db, woId) {
  const { rows: moves } = await db.execute({
    sql: `SELECT m.*, e.first_name || ' ' || e.last_name as employee_name FROM work_order_movements m
          LEFT JOIN employees e ON m.employee_id = e.id WHERE m.work_order_id = ? ORDER BY m.id`,
    args: [woId],
  });
  if (!moves.length) return moves;
  const { rows: checks } = await db.execute({
    sql: `SELECT c.*, a.line_no, a.name as accessory_name FROM work_order_movement_accessories c
          JOIN work_order_accessories a ON c.accessory_id = a.id
          JOIN work_order_movements m ON c.movement_id = m.id WHERE m.work_order_id = ? ORDER BY a.line_no`,
    args: [woId],
  });
  const { rows: photos } = await db.execute({
    sql: `SELECT p.*, ${PHOTO_URL_SQL} as url FROM work_order_photos p WHERE p.work_order_id = ? AND p.movement_id IS NOT NULL ORDER BY p.id`,
    args: [woId],
  });
  for (const m of moves) {
    m.accessories = checks.filter(c => c.movement_id === m.id);
    for (const c of m.accessories) c.photos = photos.filter(p => p.movement_id === m.id && p.accessory_id === c.accessory_id);
    m.photos = photos.filter(p => p.movement_id === m.id && !p.accessory_id);
  }
  return moves;
}

// Validates a receive's accessory checklist: every accessory on the work
// order once, condition ok|damaged|missing, a note for damaged or missing.
function checkAccessories(accessories, given) {
  const list = Array.isArray(given) ? given : [];
  const out = [];
  for (const a of accessories) {
    const g = list.find(x => Number(x.accessory_id) === a.id);
    if (!g) return { error: `Check accessory A${a.line_no} (${a.name}) — mark it OK, damaged or missing` };
    const condition = String(g.condition || '');
    if (!CONDITIONS.includes(condition)) return { error: `A${a.line_no}: condition must be OK, damaged or missing` };
    const note = String(g.note || '').trim();
    if (condition !== 'ok' && !note) return { error: `A${a.line_no} is marked ${condition} — add a note saying what's wrong` };
    out.push({ accessory_id: a.id, condition, note: note || null, line_no: a.line_no, name: a.name });
  }
  const extra = list.find(x => !accessories.some(a => a.id === Number(x.accessory_id)));
  if (extra) return { error: 'One of the accessories checked is not on this work order' };
  return { checks: out };
}

module.exports = { LOCATIONS, FINISHED, CONDITIONS, LOCATION_LABELS, locationLabel, movementState, decorateMovements, loadMovements, checkAccessories };
