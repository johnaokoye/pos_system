// FleetHub units on rentals (lib/fleethub.js): pick which units go out (Issue, Hand Over, Security Sign-Off, Replace Item) and tick which come back (Check In, Process Return, Replace Item), each with odometer / engine hours.
Object.assign(App, {
  // ── Going out ───────────────────────────────────────────────────────────
  // Fills #containerId with a unit dropdown per unit still needed on each
  // fleet-tracked line. Nothing shows unless FleetHub is on and tracks an
  // item on this rental; units that haven't passed their checklist are listed
  // but can't be picked.
  async _fleetIssuePickerLoad(agreementId, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    let plan;
    try { plan = await this.api('GET', `/rentals/agreements/${agreementId}/fleet-units`); }
    catch (e) { el.innerHTML = `<div class="fleet-box fleet-error">FleetHub: ${this.escapeAttr(e.message)}. Fleet equipment can't go out until FleetHub confirms it.</div>`; return; }
    const lines = (plan.issue || []);
    if (!plan.enabled || !lines.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="fleet-box">
      <label class="fw-600" style="display:block;margin-bottom:4px">Fleet Units <span style="font-weight:400;color:var(--text-muted);font-size:12px">— only units that passed their pre-rental checklist in FleetHub</span></label>
      ${lines.map(l => `<div style="margin-top:6px">
        <div style="font-size:12px" class="fw-600">${this.escapeAttr(l.product_name)}${this._rentalSkuTag ? this._rentalSkuTag(l.sku) : ''}</div>
        ${l.picked.map(u => `<div style="font-size:12px;color:#166534">✓ ${this.escapeAttr(u)} <span style="color:var(--text-muted)">(picked at security sign-off)</span></div>`).join('')}
        ${Array.from({ length: l.need }, (_, n) => `<select class="fleet-pick" data-item="${l.item_id}" style="margin-top:4px">
          <option value="">-- Pick unit${l.need > 1 ? ` ${n + 1} of ${l.need}` : ''} --</option>
          ${l.units.map(u => `<option value="${this.escapeAttr(u.unitNumber)}" ${u.ready ? '' : 'disabled'}>${this.escapeAttr(u.unitNumber)} — ${this.escapeAttr(u.name || '')} ${u.ready ? '✓ ready' : `✗ ${this.escapeAttr((u.reasons || []).join('; ') || u.status || 'not ready')}`}</option>`).join('')}
        </select>`).join('')}
      </div>`).join('')}
    </div>`;
  },

  // { [item_id]: [unitNumber, ...] }, null when there's no picker, or false
  // (after an alert) when a unit is left unpicked or picked twice.
  _fleetIssueSelections(containerId) {
    const selects = [...document.querySelectorAll(`#${containerId} select.fleet-pick`)];
    if (!selects.length) return null;
    if (selects.some(s => !s.value)) { this.alert('Pick a fleet unit for every item going out', 'error'); return false; }
    const vals = selects.map(s => s.value);
    if (new Set(vals).size !== vals.length) { this.alert('The same fleet unit is picked twice', 'error'); return false; }
    const out = {};
    for (const s of selects) (out[s.dataset.item] = out[s.dataset.item] || []).push(s.value);
    return out;
  },

  // ── Coming back ─────────────────────────────────────────────────────────
  // For every line with units out, fills #<prefix>-fleet-<item id> with a
  // tick box per unit plus its odometer / engine hours. `qtyInput(itemId)`
  // is that line's quantity box: the ticks start from it (or from the units
  // security ticked at check-in, `checkinLines`), and when every unit still
  // out on the line is tracked, ticking sets it.
  async _fleetReturnPickerLoad(agreementId, prefix, { qtyInput, checkinLines = [], outstanding = {} } = {}) {
    let data;
    try { data = await this.api('GET', `/rentals/agreements/${agreementId}/fleet-units`); } catch (e) { return; }
    const byItem = {};
    for (const u of data.issued || []) (byItem[u.item_id] = byItem[u.item_id] || []).push(u);
    this._fleetReturnLines = this._fleetReturnLines || {};
    for (const [itemId, units] of Object.entries(byItem)) {
      const el = document.getElementById(`${prefix}-fleet-${itemId}`);
      if (!el) continue;
      const fromCheckin = (checkinLines.find(l => String(l.item_id) === itemId) || {}).units;
      const qtyEl = qtyInput ? qtyInput(itemId) : null;
      const allTracked = units.length >= (outstanding[itemId] ?? units.length);
      let tickN = fromCheckin ? 0 : Math.min(units.length, parseInt(qtyEl?.value) || 0);
      el.innerHTML = `<div class="fleet-box" style="margin-top:6px">
        <div style="font-size:12px;margin-bottom:4px" class="fw-600">Fleet units coming back <span style="font-weight:400;color:var(--text-muted)">— tick each one, with its odometer / engine hours</span></div>
        ${units.map((u, n) => {
          const c = fromCheckin ? fromCheckin.find(x => x.unit_number === u.unit_number) : null;
          const on = fromCheckin ? !!c : n < tickN;
          return `<div class="fleet-ret-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">
            <label style="display:flex;align-items:center;gap:6px;min-width:120px;margin:0"><input type="checkbox" class="fleet-ret" data-unit="${this.escapeAttr(u.unit_number)}" ${on ? 'checked' : ''}> ${this.escapeAttr(u.unit_number)}</label>
            <input type="number" class="fleet-odo" placeholder="Odometer" min="0" step="1" style="width:110px" value="${c && c.odometer != null ? c.odometer : ''}">
            <input type="number" class="fleet-hrs" placeholder="Engine hours" min="0" step="0.1" style="width:110px" value="${c && c.meter_hours != null ? c.meter_hours : ''}">
          </div>`;
        }).join('')}
      </div>`;
      if (allTracked && qtyEl) {
        const sync = () => { qtyEl.value = el.querySelectorAll('input.fleet-ret:checked').length; };
        el.querySelectorAll('input.fleet-ret').forEach(cb => cb.addEventListener('change', sync));
        if (fromCheckin) sync();
        qtyEl.addEventListener('change', () => {
          const want = Math.max(0, Math.min(units.length, parseInt(qtyEl.value) || 0));
          el.querySelectorAll('input.fleet-ret').forEach((cb, n) => { cb.checked = n < want; });
        });
      }
    }
  },

  // The ticked units of one line, or undefined when it has no fleet units.
  _fleetReturnSelections(prefix, itemId) {
    const el = document.getElementById(`${prefix}-fleet-${itemId}`);
    if (!el || !el.querySelector('input.fleet-ret')) return undefined;
    return [...el.querySelectorAll('.fleet-ret-row')].filter(r => r.querySelector('input.fleet-ret').checked).map(r => ({
      unit_number: r.querySelector('input.fleet-ret').dataset.unit,
      odometer: r.querySelector('.fleet-odo').value === '' ? null : Number(r.querySelector('.fleet-odo').value),
      meter_hours: r.querySelector('.fleet-hrs').value === '' ? null : Number(r.querySelector('.fleet-hrs').value),
    }));
  },

  // ── Replace Item ────────────────────────────────────────────────────────
  // Which unit(s) of the line come back, and which fleet unit(s) of the
  // replacement go out. Redrawn when the line, quantity or replacement changes.
  async _fleetReplaceLoad(agreementId) {
    try { this._rplFleet = await this.api('GET', `/rentals/agreements/${agreementId}/fleet-units`); } catch (e) { this._rplFleet = { issued: [] }; }
    this._rplFleetSku = {};
    this._fleetReplaceRender();
  },

  async _fleetReplaceRender() {
    const backEl = document.getElementById('rpl-fleet-back');
    const newEl = document.getElementById('rpl-fleet-new');
    if (!backEl || !newEl || !this._rplFleet) return;
    const itemId = Number(document.getElementById('rpl-item')?.value);
    const qty = parseInt(document.getElementById('rpl-qty')?.value) || 0;
    const onLine = (this._rplFleet.issued || []).filter(u => u.item_id === itemId);
    backEl.innerHTML = onLine.length ? `<div class="fleet-box">
      <div style="font-size:12px;margin-bottom:4px" class="fw-600">Fleet unit${qty === 1 ? '' : 's'} coming back <span style="font-weight:400;color:var(--text-muted)">— tick ${qty}</span></div>
      ${onLine.map((u, n) => `<div class="fleet-ret-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">
        <label style="display:flex;align-items:center;gap:6px;min-width:120px;margin:0"><input type="checkbox" class="fleet-ret" data-unit="${this.escapeAttr(u.unit_number)}" ${n < qty ? 'checked' : ''}> ${this.escapeAttr(u.unit_number)}</label>
        <input type="number" class="fleet-odo" placeholder="Odometer" min="0" step="1" style="width:110px">
        <input type="number" class="fleet-hrs" placeholder="Engine hours" min="0" step="0.1" style="width:110px">
      </div>`).join('')}
    </div>` : '';
    const p = this._replaceProducts?.find(x => String(x.id) === document.getElementById('rpl-product')?.value);
    newEl.innerHTML = '';
    if (!p || !p.sku || !this._rplFleet.enabled) return;
    if (!(p.sku in this._rplFleetSku)) {
      try { this._rplFleetSku[p.sku] = (await this.api('GET', `/rentals/fleet-units?sku=${encodeURIComponent(p.sku)}`)).units || []; }
      catch (e) { newEl.innerHTML = `<div class="fleet-box fleet-error">FleetHub: ${this.escapeAttr(e.message)}</div>`; return; }
    }
    const units = this._rplFleetSku[p.sku];
    if (!units.length) return;
    newEl.innerHTML = `<div class="fleet-box">
      <div style="font-size:12px;margin-bottom:4px" class="fw-600">Replacement fleet unit${qty === 1 ? '' : 's'} <span style="font-weight:400;color:var(--text-muted)">— only units that passed their pre-rental checklist</span></div>
      ${Array.from({ length: qty }, () => `<select class="fleet-pick" data-item="new" style="margin-top:4px">
        <option value="">-- Pick unit --</option>
        ${units.map(u => `<option value="${this.escapeAttr(u.unitNumber)}" ${u.ready ? '' : 'disabled'}>${this.escapeAttr(u.unitNumber)} — ${this.escapeAttr(u.name || '')} ${u.ready ? '✓ ready' : `✗ ${this.escapeAttr((u.reasons || []).join('; ') || 'not ready')}`}</option>`).join('')}
      </select>`).join('')}
    </div>`;
  },

  // { return_units, fleet_units } for the swap, or false after an alert.
  _fleetReplaceSelections() {
    const back = [...document.querySelectorAll('#rpl-fleet-back .fleet-ret-row')].filter(r => r.querySelector('input.fleet-ret').checked).map(r => ({
      unit_number: r.querySelector('input.fleet-ret').dataset.unit,
      odometer: r.querySelector('.fleet-odo').value === '' ? null : Number(r.querySelector('.fleet-odo').value),
      meter_hours: r.querySelector('.fleet-hrs').value === '' ? null : Number(r.querySelector('.fleet-hrs').value),
    }));
    const picked = this._fleetIssueSelections('rpl-fleet-new');
    if (picked === false) return false;
    return { return_units: back, fleet_units: picked ? picked.new : undefined };
  },

  // ── Agreement view ──────────────────────────────────────────────────────
  _fleetUnitsRecordHtml(units) {
    if (!units || !units.length) return '';
    const label = { out: 'Picked — awaiting delivery', issued: 'Out', returned: 'Back', cancelled: 'Released' };
    return `<div style="margin-top:12px">
      <div class="fw-600" style="font-size:13px;margin-bottom:4px">Fleet Units (FleetHub)</div>
      <table class="data-table" style="font-size:12px"><thead><tr><th>Unit</th><th>Item</th><th>Status</th><th>Out</th><th>Back</th><th>Readings</th></tr></thead><tbody>
      ${units.map(u => `<tr>
        <td class="fw-600">${this.escapeAttr(u.unit_number)}</td>
        <td>${this.escapeAttr(u.product_name || '')}</td>
        <td>${label[u.status] || u.status}${u.sync_pending ? ` <span class="badge-pill badge-warning" title="${this.escapeAttr(u.last_error || 'Waiting to be sent')}">not yet in FleetHub</span>` : ''}</td>
        <td>${u.issued_at ? this.fmtDateTime(u.issued_at) : '—'}</td>
        <td>${u.returned_at ? this.fmtDateTime(u.returned_at) : '—'}</td>
        <td>${[u.odometer != null ? `odometer ${Number(u.odometer).toLocaleString()}` : '', u.meter_hours != null ? `${u.meter_hours} h` : ''].filter(Boolean).join(' · ') || '—'}</td>
      </tr>`).join('')}
      </tbody></table>
    </div>`;
  },
});
