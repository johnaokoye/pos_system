// FleetHub integration — FleetHub (separate app) owns servicing checklists for
// individual rental units. A POS rental line is quantity-based ("Scissor lift
// × 1"), so the specific physical unit going out is picked here and recorded in
// rental_fleet_units. FleetHub links its units to POS products by SKU: if
// FleetHub has any units for an item's SKU, that item is "fleet-tracked" and
// can't be issued until every unit on it has passed its pre-rental checklist.
//
// Disabled entirely (no gating, no calls) unless FLEETHUB_URL is set. Once
// enabled it fails CLOSED at issue — if FleetHub can't confirm a unit is
// ready, the item doesn't leave — but returns never block: the equipment is
// already back, so a failed return sync is queued and retried by server.js.

const FLEETHUB_URL = (process.env.FLEETHUB_URL || '').replace(/\/+$/, '');
const FLEETHUB_API_KEY = process.env.FLEETHUB_API_KEY || '';

class FleetHubError extends Error {
  constructor(message, details) {
    super(details && details.length ? `${message}: ${details.join('; ')}` : message);
    this.details = details || [];
  }
}

function enabled() {
  return !!FLEETHUB_URL;
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${FLEETHUB_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${FLEETHUB_API_KEY}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new FleetHubError(`FleetHub is unreachable (${e.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new FleetHubError(data.error || `FleetHub responded ${res.status}`, data.details);
  return data;
}

// One FleetHub rental per unit, so the ref is agreement + unit.
const posRefFor = (agreementNumber, unitNumber) => `${agreementNumber}:${unitNumber}`;

// Items on the agreement FleetHub tracks, each with FleetHub's candidate units
// (and their readiness) plus whatever is already assigned here.
async function fleetPlan(executor, agreementId) {
  const { rows: items } = await executor.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [agreementId] });
  const { rows: assigned } = await executor.execute({ sql: "SELECT * FROM rental_fleet_units WHERE agreement_id = ? AND status IN ('assigned','issued')", args: [agreementId] });
  const unitsBySku = {};
  for (const sku of [...new Set(items.map(i => i.sku).filter(Boolean))]) {
    unitsBySku[sku] = (await call('GET', `/api/pos/units?sku=${encodeURIComponent(sku)}`)).units;
  }
  return items
    .filter(i => i.sku && unitsBySku[i.sku]?.length)
    .map(i => ({
      item_id: i.id,
      product_name: i.product_name,
      sku: i.sku,
      quantity: i.quantity,
      units: unitsBySku[i.sku],
      assigned: assigned.filter(a => a.item_id === i.id).map(a => a.unit_number),
    }));
}

// Validates a { [item_id]: [unitNumber, ...] } selection against FleetHub and
// stores it. Every tracked item must get exactly `quantity` distinct units.
// Readiness is checked here for early feedback; checkoutAssigned() re-checks it atomically in FleetHub.
async function assignUnits(executor, agreement, selection) {
  const plan = await fleetPlan(executor, agreement.id);
  if (!plan.length) return [];
  selection = selection || {};
  const rows = [];
  const seen = new Set();
  for (const p of plan) {
    const chosen = (selection[p.item_id] || p.assigned).map(u => String(u).trim()).filter(Boolean);
    if (chosen.length !== p.quantity) throw new FleetHubError(`Select ${p.quantity} unit(s) for "${p.product_name}"`);
    for (const unitNumber of chosen) {
      const unit = p.units.find(u => u.unitNumber === unitNumber);
      if (!unit) throw new FleetHubError(`Unit ${unitNumber} is not a "${p.product_name}" in FleetHub`);
      if (seen.has(unitNumber)) throw new FleetHubError(`Unit ${unitNumber} is selected more than once`);
      if (!unit.ready) throw new FleetHubError(`Unit ${unitNumber} is not ready for rental`, unit.reasons);
      seen.add(unitNumber);
      rows.push({ item_id: p.item_id, unit_number: unitNumber });
    }
  }
  await executor.execute({ sql: "DELETE FROM rental_fleet_units WHERE agreement_id = ? AND status = 'assigned'", args: [agreement.id] });
  for (const r of rows) {
    await executor.execute({
      sql: "INSERT INTO rental_fleet_units (agreement_id, item_id, unit_number, pos_ref, status) VALUES (?,?,?,?,'assigned')",
      args: [agreement.id, r.item_id, r.unit_number, posRefFor(agreement.agreement_number, r.unit_number)],
    });
  }
  return rows;
}

// Checks out every assigned unit in FleetHub — this is the gate. All or
// nothing: if any unit is refused, the ones already checked out are cancelled.
// Returns the refs so the caller can undo them if its own write then fails.
async function checkoutAssigned(executor, agreement) {
  const { rows } = await executor.execute({ sql: "SELECT * FROM rental_fleet_units WHERE agreement_id = ? AND status = 'assigned'", args: [agreement.id] });
  const done = [];
  for (const r of rows) {
    try {
      await call('POST', '/api/pos/rentals/checkout', { unitNumber: r.unit_number, posRef: r.pos_ref });
      done.push(r.pos_ref);
    } catch (e) {
      await cancelCheckouts(done);
      throw new FleetHubError(`Unit ${r.unit_number} can't be issued — ${e.message}`);
    }
  }
  return done;
}

async function markIssued(executor, agreementId) {
  await executor.execute({ sql: "UPDATE rental_fleet_units SET status = 'issued', issued_at = CURRENT_TIMESTAMP WHERE agreement_id = ? AND status = 'assigned'", args: [agreementId] });
}

async function cancelCheckouts(posRefs) {
  for (const posRef of posRefs) {
    try { await call('POST', '/api/pos/rentals/cancel', { posRef }); } catch (e) { console.error(`FleetHub cancel ${posRef} failed:`, e.message); }
  }
}

// Marks issued units as returned (optionally only those on the given items)
// and tells FleetHub, which puts them back to "needs pre-rental checklist".
// Never throws: failures stay sync_pending=1 for retryPendingReturns.
async function returnUnits(executor, agreementId, itemIds) {
  if (itemIds && !itemIds.length) return;
  const itemFilter = itemIds ? ` AND item_id IN (${itemIds.map(() => '?').join(',')})` : '';
  await executor.execute({
    sql: `UPDATE rental_fleet_units SET status = 'returned', returned_at = CURRENT_TIMESTAMP, sync_pending = 1 WHERE agreement_id = ? AND status = 'issued'${itemFilter}`,
    args: [agreementId, ...(itemIds || [])],
  });
  await retryPendingReturns(executor, agreementId);
}

async function retryPendingReturns(executor, agreementId) {
  if (!enabled()) return;
  const { rows } = await executor.execute({
    sql: `SELECT * FROM rental_fleet_units WHERE sync_pending = 1${agreementId ? ' AND agreement_id = ?' : ''}`,
    args: agreementId ? [agreementId] : [],
  });
  for (const r of rows) {
    try {
      await call('POST', '/api/pos/rentals/return', { posRef: r.pos_ref });
      await executor.execute({ sql: 'UPDATE rental_fleet_units SET sync_pending = 0, last_error = NULL WHERE id = ?', args: [r.id] });
    } catch (e) {
      await executor.execute({ sql: 'UPDATE rental_fleet_units SET last_error = ? WHERE id = ?', args: [e.message, r.id] });
    }
  }
}

module.exports = { enabled, FleetHubError, fleetPlan, assignUnits, checkoutAssigned, markIssued, cancelCheckouts, returnUnits, retryPendingReturns };
