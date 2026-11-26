// FleetHub integration — FleetHub (~/fleethub, a separate app) owns the
// servicing checklists of individual rental units. A POS rental line is
// quantity-based ("Scissor lift × 2"), so the physical units going out are
// picked here and recorded in rental_fleet_units. FleetHub links its units to
// POS products by SKU: a line whose SKU FleetHub has units for is
// "fleet-tracked" and can't go out until FleetHub checks each unit out, which
// it refuses unless the unit passed its pre-rental checklist.
//
// Off entirely (no gating, no calls) unless FLEETHUB_URL is set. Once on it
// fails CLOSED going out — no confirmation from FleetHub, no issue — but
// never blocks a unit coming back: returns are recorded here, marked
// sync_pending and sent now or by the 5-minute retry in server.js.
//
// Flow: counter issue (desk or guard Hand Over) picks + checks out in one
// step. A delivery's units are picked + checked out at Security Sign-Off
// (status 'out'), and the driver's issue then just marks them issued. Each
// unit comes back on its own at the guard's Return Check-In or the desk's
// Process Return (with odometer / engine hours), and a paused rental's swap
// returns the old unit(s) and checks out the replacement(s).

const base = () => (process.env.FLEETHUB_URL || '').replace(/\/+$/, '');

class FleetHubError extends Error {
  constructor(message, details) {
    super(details && details.length ? `${message}: ${details.join('; ')}` : message);
    this.details = details || [];
  }
}

const enabled = () => !!base();

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { authorization: `Bearer ${process.env.FLEETHUB_API_KEY || ''}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new FleetHubError(`FleetHub can't be reached (${e.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new FleetHubError(`FleetHub: ${data.error || `answered ${res.status}`}`, data.details);
  return data;
}

// FleetHub's units for a SKU, each { unitNumber, name, status, ready, reasons }.
// Empty = FleetHub doesn't track that product.
async function unitsForSku(sku) {
  if (!enabled() || !sku) return [];
  return (await call('GET', `/api/pos/units?sku=${encodeURIComponent(sku)}`)).units || [];
}

const LIVE = "status IN ('out','issued')";

// The fleet-tracked lines still to go out on an awaiting-issue agreement:
// each with FleetHub's candidate units, the units already picked (a delivery
// signed off by security) and how many are still needed.
async function issuePlan(executor, agreementId) {
  if (!enabled()) return [];
  const { rows: items } = await executor.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ? ORDER BY id', args: [agreementId] });
  const { rows: live } = await executor.execute({ sql: `SELECT * FROM rental_fleet_units WHERE agreement_id = ? AND ${LIVE}`, args: [agreementId] });
  const bySku = {};
  for (const sku of [...new Set(items.map(i => i.sku).filter(Boolean))]) bySku[sku] = await unitsForSku(sku);
  return items.filter(i => i.sku && bySku[i.sku].length).map(i => {
    const picked = live.filter(r => r.item_id === i.id).map(r => r.unit_number);
    return {
      item_id: i.id, product_name: i.product_name, sku: i.sku, quantity: i.quantity,
      units: bySku[i.sku], picked, need: Math.max(0, i.quantity - picked.length),
    };
  });
}

// Checks a { [item_id]: [unitNumber, ...] } choice against the plan: every
// line gets exactly the units it still needs, each one of that SKU, not on
// another line or already out on this agreement. Returns [{ item_id, unit_number }].
function chosenUnits(plan, selection) {
  selection = selection || {};
  const rows = [];
  const seen = new Set(plan.flatMap(p => p.picked));
  for (const p of plan) {
    if (!p.need) continue;
    const chosen = (selection[p.item_id] || []).map(u => String(u).trim()).filter(Boolean);
    if (chosen.length !== p.need) throw new FleetHubError(`Pick ${p.need} unit${p.need === 1 ? '' : 's'} for ${p.product_name}`);
    for (const unitNumber of chosen) {
      const unit = p.units.find(u => u.unitNumber === unitNumber);
      if (!unit) throw new FleetHubError(`Unit ${unitNumber} isn't a ${p.product_name} in FleetHub`);
      if (seen.has(unitNumber)) throw new FleetHubError(`Unit ${unitNumber} is picked more than once`);
      if (!unit.ready) throw new FleetHubError(`Unit ${unitNumber} isn't ready to rent`, unit.reasons);
      seen.add(unitNumber);
      rows.push({ item_id: p.item_id, unit_number: unitNumber });
    }
  }
  return rows;
}

// One FleetHub rental per unit per time out: agreement + unit, with a
// counter if that unit already went out on this agreement before (a swap back).
async function posRefFor(executor, agreement, unitNumber) {
  const ref = `${agreement.agreement_number}:${unitNumber}`;
  const { rows: [{ n }] } = await executor.execute({ sql: 'SELECT COUNT(*) as n FROM rental_fleet_units WHERE pos_ref = ? OR pos_ref LIKE ?', args: [ref, `${ref}#%`] });
  return n ? `${ref}#${n + 1}` : ref;
}

// The gate: checks the units out in FleetHub, all or nothing (any refusal
// cancels the ones already done), then records them with `status`. Returns
// the rows so the caller can undoCheckout() if its own write then fails.
async function checkOut(executor, agreement, rows, { status = 'out', employeeId = null } = {}) {
  const done = [];
  for (const r of rows) {
    const pos_ref = await posRefFor(executor, agreement, r.unit_number);
    try {
      await call('POST', '/api/pos/rentals/checkout', { unitNumber: r.unit_number, posRef: pos_ref });
    } catch (e) {
      await cancelRefs(done.map(d => d.pos_ref));
      throw new FleetHubError(`Unit ${r.unit_number} can't go out — ${e.message}`);
    }
    done.push({ ...r, pos_ref });
  }
  try {
    for (const d of done) {
      const ins = await executor.execute({
        sql: `INSERT INTO rental_fleet_units (agreement_id, item_id, unit_number, pos_ref, status, checked_out_by, issued_at) VALUES (?,?,?,?,?,?,?)`,
        args: [agreement.id, d.item_id, d.unit_number, d.pos_ref, status, employeeId, status === 'issued' ? new Date().toISOString() : null],
      });
      d.id = Number(ins.lastInsertRowid);
    }
  } catch (e) {
    await undoCheckout(executor, done);
    throw e;
  }
  return done;
}

async function cancelRefs(refs) {
  for (const posRef of refs) {
    try { await call('POST', '/api/pos/rentals/cancel', { posRef }); } catch (e) { console.error(`[fleethub] cancel ${posRef} failed:`, e.message); }
  }
}

// Undo checkOut() when the step it was part of didn't go through.
async function undoCheckout(executor, rows) {
  if (!rows || !rows.length) return;
  await cancelRefs(rows.map(r => r.pos_ref));
  for (const r of rows) {
    if (r.id) { try { await executor.execute({ sql: 'DELETE FROM rental_fleet_units WHERE id = ?', args: [r.id] }); } catch (e) {} }
  }
}

async function markIssued(executor, agreementId, issuedAt) {
  await executor.execute({ sql: "UPDATE rental_fleet_units SET status = 'issued', issued_at = ? WHERE agreement_id = ? AND status = 'out'", args: [issuedAt || new Date().toISOString(), agreementId] });
}

// Units out on an agreement's lines (local only — works with FleetHub down).
async function issuedUnits(executor, agreementId) {
  const { rows } = await executor.execute({ sql: "SELECT id, item_id, unit_number, pos_ref FROM rental_fleet_units WHERE agreement_id = ? AND status = 'issued' ORDER BY id", args: [agreementId] });
  return rows;
}

function reading(v, label, integer) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new FleetHubError(`${label} must be ${integer ? 'a whole number' : 'a number'} of 0 or more`);
  return n;
}

// Which units come back with a return / check-in / swap. `lines` are
// [{ item_id, quantity, units: [{ unit_number, odometer?, meter_hours? }] }]
// against the agreement's items. A line whose every outstanding unit is
// tracked must name exactly `quantity` units; one with some untracked units
// (issued before FleetHub was switched on) names as many as can't be untracked.
// Returns [{ id, unit_number, odometer, meter_hours }] to pass to markReturned().
async function unitsComingBack(executor, agreementId, items, lines) {
  const out = await issuedUnits(executor, agreementId);
  if (!out.length) return [];
  const result = [];
  for (const line of lines) {
    const item = items.find(i => i.id === Number(line.item_id));
    if (!item) continue;
    const onLine = out.filter(r => r.item_id === item.id);
    if (!onLine.length) continue;
    const qty = Number(line.quantity) || 0;
    const stillOut = item.quantity - item.quantity_returned;
    const min = Math.max(0, qty - (stillOut - onLine.length));
    const max = Math.min(qty, onLine.length);
    const given = Array.isArray(line.units) ? line.units : [];
    const label = `${item.product_name}`;
    if (given.length < min || given.length > max) {
      throw new FleetHubError(min === max ? `Tick the ${min} unit${min === 1 ? '' : 's'} of ${label} coming back` : `Tick between ${min} and ${max} units of ${label} coming back`);
    }
    const seen = new Set();
    for (const u of given) {
      const unitNumber = String((u && u.unit_number) || u || '').trim();
      const row = onLine.find(r => r.unit_number === unitNumber);
      if (!row) throw new FleetHubError(`Unit ${unitNumber || '?'} isn't out on ${label}`);
      if (seen.has(unitNumber)) throw new FleetHubError(`Unit ${unitNumber} is ticked twice`);
      seen.add(unitNumber);
      result.push({ id: row.id, unit_number: unitNumber, odometer: reading(u.odometer, `Odometer for ${unitNumber}`, true), meter_hours: reading(u.meter_hours, `Engine hours for ${unitNumber}`, false) });
    }
  }
  return result;
}

// Records the units as back (inside the caller's transaction) for syncPending().
async function markReturned(executor, units, { employeeId = null, at } = {}) {
  for (const u of units) {
    await executor.execute({
      sql: "UPDATE rental_fleet_units SET status = 'returned', returned_at = ?, returned_by = ?, odometer = ?, meter_hours = ?, sync_pending = 1, last_error = NULL WHERE id = ? AND status = 'issued'",
      args: [at || new Date().toISOString(), employeeId, u.odometer ?? null, u.meter_hours ?? null, u.id],
    });
  }
}

// Cancelling an agreement: issued units are back (needs a checklist), and a
// delivery's units picked at sign-off are back too once a driver took them —
// otherwise they never left and go straight back to available.
async function releaseForCancel(executor, agreement, employeeId) {
  const left = !!agreement.delivery_driver_confirmed_at;
  await executor.execute({
    sql: `UPDATE rental_fleet_units SET status = CASE WHEN status = 'issued' OR ? THEN 'returned' ELSE 'cancelled' END,
      returned_at = CURRENT_TIMESTAMP, returned_by = ?, sync_pending = 1, last_error = NULL WHERE agreement_id = ? AND ${LIVE}`,
    args: [left ? 1 : 0, employeeId || null, agreement.id],
  });
}

// Tells FleetHub about returns/cancels recorded here. Never throws.
async function syncPending(executor, agreementId) {
  if (!enabled()) return;
  try {
    const { rows } = await executor.execute({
      sql: `SELECT * FROM rental_fleet_units WHERE sync_pending = 1${agreementId ? ' AND agreement_id = ?' : ''} ORDER BY id`,
      args: agreementId ? [agreementId] : [],
    });
    for (const r of rows) {
      try {
        if (r.status === 'cancelled') await call('POST', '/api/pos/rentals/cancel', { posRef: r.pos_ref });
        else {
          const body = { posRef: r.pos_ref };
          if (r.odometer != null) body.odometer = Math.round(r.odometer);
          if (r.meter_hours != null) body.meterHours = Number(r.meter_hours);
          await call('POST', '/api/pos/rentals/return', body);
        }
        await executor.execute({ sql: 'UPDATE rental_fleet_units SET sync_pending = 0, last_error = NULL WHERE id = ?', args: [r.id] });
      } catch (e) {
        await executor.execute({ sql: 'UPDATE rental_fleet_units SET last_error = ? WHERE id = ?', args: [String(e.message).slice(0, 500), r.id] });
      }
    }
  } catch (e) { console.error('[fleethub] sync failed:', e.message); }
}

// For the agreement view: every unit that went out on it.
async function unitsForAgreement(executor, agreementId) {
  const { rows } = await executor.execute({
    sql: `SELECT fu.*, i.product_name, i.sku FROM rental_fleet_units fu LEFT JOIN rental_agreement_items i ON i.id = fu.item_id
      WHERE fu.agreement_id = ? ORDER BY fu.id`, args: [agreementId] });
  return rows;
}

module.exports = {
  enabled, FleetHubError, unitsForSku, issuePlan, chosenUnits, checkOut, undoCheckout, markIssued,
  issuedUnits, unitsComingBack, markReturned, releaseForCancel, syncPending, unitsForAgreement,
};
