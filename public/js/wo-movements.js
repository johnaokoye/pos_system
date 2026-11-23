// Work order item movements: store → Warehouse → service center and back, with photo + accessory checkpoints on receipt.
Object.assign(App, {
  _woLocLabel(loc, wo) {
    if (loc === 'store') return wo && wo.branch_name && !Number(wo.branch_is_warehouse) ? wo.branch_name : 'Store';
    return { warehouse: 'Warehouse', service_center: 'Service Center' }[loc] || loc;
  },

  _woNextMoveLabel(wo) {
    const n = wo.movement && wo.movement.next;
    if (!n) return '';
    return n.kind === 'send' ? `Send to ${this._woLocLabel(n.to, wo)}` : `Receive at ${this._woLocLabel(n.to, wo)}`;
  },

  // Where the item is — for list rows and the view
  _woWhereBadge(wo) {
    const m = wo.movement;
    if (!m || wo.status === 'picked_up' || wo.returned_to_customer_at) return '';
    if (m.in_transit) return `<div style="font-size:11px;color:var(--warning)">🚚 On the way to ${this.escapeAttr(this._woLocLabel(m.in_transit.to, wo))}</div>`;
    return `<div style="font-size:11px;color:var(--text-muted)">📍 At ${this.escapeAttr(this._woLocLabel(m.location, wo))}</div>`;
  },

  _woMoveButton(wo, from) {
    const n = wo.movement && wo.movement.next;
    if (!n || !this.can('wo_movements')) return '';
    const fn = n.kind === 'send' ? 'showWOSendModal' : 'showWOReceiveModal';
    return `<button class="btn btn-sm btn-primary" onclick="App.${fn}(${wo.id}, '${from}')">${n.kind === 'send' ? '🚚' : '📥'} ${this.escapeAttr(this._woNextMoveLabel(wo))}</button>`;
  },

  _woMovementSectionHtml(wo) {
    const m = wo.movement;
    if (!m) return '';
    const moves = wo.movements || [];
    const condLabel = { ok: 'OK', damaged: 'Damaged', missing: 'Missing' };
    const condColor = { ok: 'var(--success)', damaged: 'var(--warning)', missing: 'var(--danger)' };
    const row = mv => mv.kind === 'send'
      ? `<div style="border-top:1px dashed var(--border);padding:6px 0">🚚 <strong>Sent</strong> ${this.escapeAttr(this._woLocLabel(mv.from_location, wo))} → ${this.escapeAttr(this._woLocLabel(mv.to_location, wo))}
          <div style="color:var(--text-muted);font-size:12px">${this.fmtDateTime(mv.created_at)}${mv.employee_name ? ` · by ${this.escapeAttr(mv.employee_name)}` : ''}${mv.carried_by ? ` · carried by ${this.escapeAttr(mv.carried_by)}` : ''}</div>
          ${mv.notes ? `<div style="font-size:12px">${this.escapeAttr(mv.notes)}</div>` : ''}</div>`
      : `<div class="wo-move-receive" style="border-top:1px dashed var(--border);padding:6px 0">📥 <strong>Received at ${this.escapeAttr(this._woLocLabel(mv.to_location, wo))}</strong>
          <div style="color:var(--text-muted);font-size:12px">${this.fmtDateTime(mv.created_at)}${mv.employee_name ? ` · by ${this.escapeAttr(mv.employee_name)}` : ''}</div>
          ${mv.notes ? `<div style="font-size:12px">${this.escapeAttr(mv.notes)}</div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">${this._woPhotoThumbs(mv.photos || [], wo.id, false)}</div>
          ${(mv.accessories || []).map(c => `<div style="font-size:12px;margin-top:4px"><strong>A${c.line_no}</strong> ${this.escapeAttr(c.accessory_name)} — <span style="color:${condColor[c.condition]};font-weight:600">${condLabel[c.condition] || c.condition}</span>${c.note ? `: ${this.escapeAttr(c.note)}` : ''}
              ${(c.photos || []).length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px">${this._woPhotoThumbs(c.photos, wo.id, false)}</div>` : ''}</div>`).join('')}
        </div>`;
    return `<div id="wo-movements" style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:13px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Item Movements</strong>
        ${this._woMoveButton(wo, 'view')}
      </div>
      <div style="margin-top:4px">${m.in_transit
        ? `🚚 On the way from ${this.escapeAttr(this._woLocLabel(m.in_transit.from, wo))} to <strong>${this.escapeAttr(this._woLocLabel(m.in_transit.to, wo))}</strong>`
        : `📍 At <strong>${this.escapeAttr(this._woLocLabel(m.location, wo))}</strong>`}
        ${m.assessment_blocked ? '<div style="font-size:12px;color:var(--warning)">Assessment waits until the Warehouse receives the item</div>' : ''}
        ${['awaiting_pickup', 'complete', 'not_worth_fixing', 'cancelled'].includes(wo.status) && !wo.returned_to_customer_at && !m.at_home ? `<div style="font-size:12px;color:var(--warning)">Not back at ${this.escapeAttr(this._woLocLabel(m.home, wo))} yet — the customer can't collect it until it's received there</div>` : ''}
      </div>
      ${moves.length ? moves.map(row).join('') : '<div style="color:var(--text-muted);font-size:12px;margin-top:4px">No movements recorded</div>'}
    </div>`;
  },

  async showWOSendModal(id, from) {
    try {
      const wo = await this.api('GET', `/work-orders/${id}`);
      const n = wo.movement && wo.movement.next;
      if (!n || n.kind !== 'send') { this.alert('There is nothing to send on this work order', 'error'); return; }
      this._woMoveFrom = from;
      this.showModal(`
        <div class="modal" style="max-width:440px">
          <div class="modal-header"><span class="modal-title">Send ${wo.wo_number} to ${this.escapeAttr(this._woLocLabel(n.to, wo))}</span><button class="modal-close">✕</button></div>
          <div class="modal-body">
            <p style="font-size:13px;margin-top:0">${this.escapeAttr(wo.item_label || wo.description)} — from ${this.escapeAttr(this._woLocLabel(n.from, wo))}${(wo.accessories || []).length ? ` with ${(wo.accessories || []).length} accessor${wo.accessories.length === 1 ? 'y' : 'ies'} (${wo.accessories.map(a => `A${a.line_no} ${this.escapeAttr(a.name)}`).join(', ')})` : ''}.</p>
            <div class="form-group"><label>Carried by (driver) *</label><input id="wo-send-carrier" placeholder="Driver or person taking it"></div>
            <div class="form-group"><label>Notes</label><input id="wo-send-notes" placeholder="Optional — e.g. packed in box 3"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
            <button class="btn btn-primary" id="wo-send-btn" onclick="App.confirmWOSend(${id}, '${n.to}')">Send</button>
          </div>
        </div>`);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async confirmWOSend(id, to) {
    const carried_by = document.getElementById('wo-send-carrier').value.trim();
    const notes = document.getElementById('wo-send-notes').value.trim();
    if (!carried_by) { this.alert('Enter who is taking the item', 'error'); return; }
    const btn = document.getElementById('wo-send-btn');
    btn.disabled = true;
    try {
      await this.api('POST', `/work-orders/${id}/movements/send`, { to, carried_by, notes });
      this.closeModal();
      this.alert(`Sent to ${this._woLocLabel(to)}`);
      await this._woAfterMove(id);
    } catch(e) { this.alert(e.message, 'error'); btn.disabled = false; }
  },

  async showWOReceiveModal(id, from) {
    try {
      const wo = await this.api('GET', `/work-orders/${id}`);
      const n = wo.movement && wo.movement.next;
      if (!n || n.kind !== 'receive') { this.alert('The item is not on its way anywhere', 'error'); return; }
      this._woMoveFrom = from;
      const accs = wo.accessories || [];
      this.showModal(`
        <div class="modal" style="max-width:560px">
          <div class="modal-header"><span class="modal-title">Receive ${wo.wo_number} at ${this.escapeAttr(this._woLocLabel(n.to, wo))}</span><button class="modal-close">✕</button></div>
          <div class="modal-body">
            <p style="font-size:13px;margin-top:0">${this.escapeAttr(wo.item_label || '')}${wo.item_serial ? ` · Item # ${this.escapeAttr(wo.item_serial)}` : ''} — ${this.escapeAttr(wo.description)}</p>
            ${(wo.photos || []).length ? `<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Intake photos — compare</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 10px">${this._woPhotoThumbs(wo.photos, wo.id, false)}</div>` : ''}
            <div class="form-group"><label>Photos of the item as it arrived *</label><input type="file" id="wo-rcv-item-photos" accept="image/*" multiple></div>
            ${accs.length ? `<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-top:6px">Accessories — check each one</div>
              ${accs.map(a => `<div class="wo-rcv-acc" data-acc="${a.id}" style="border-top:1px dashed var(--border);padding:6px 0">
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                  <div><strong>A${a.line_no}</strong> ${this.escapeAttr(a.name)}${a.serial_number ? ` · ${this.escapeAttr(a.serial_number)}` : ''}<div style="font-size:12px;color:var(--text-muted)">${this.escapeAttr(a.description)}</div></div>
                  <select id="wo-rcv-cond-${a.id}" style="width:auto"><option value="">— Check —</option><option value="ok">OK</option><option value="damaged">Damaged</option><option value="missing">Missing</option></select>
                </div>
                ${(a.photos || []).length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${this._woPhotoThumbs(a.photos, wo.id, false)}</div>` : ''}
                <div style="display:flex;gap:6px;margin-top:4px"><input id="wo-rcv-note-${a.id}" placeholder="Note (required if damaged or missing)" style="flex:1"><input type="file" id="wo-rcv-photo-${a.id}" accept="image/*" multiple style="max-width:190px"></div>
              </div>`).join('')}` : '<p style="font-size:12px;color:var(--text-muted)">No accessories were handed in with this item.</p>'}
            <div class="form-group" style="margin-top:8px"><label>Notes</label><input id="wo-rcv-notes" placeholder="Optional"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
            <button class="btn btn-primary" id="wo-rcv-btn" onclick="App.confirmWOReceive(${id}, '${n.to}')">Receive</button>
          </div>
        </div>`);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async confirmWOReceive(id, at) {
    const itemFiles = [...document.getElementById('wo-rcv-item-photos').files];
    if (!itemFiles.length) { this.alert('Take at least one photo of the item as it arrived', 'error'); return; }
    const fd = new FormData();
    const accessories = [];
    for (const el of document.querySelectorAll('.wo-rcv-acc')) {
      const accId = Number(el.dataset.acc);
      const condition = document.getElementById(`wo-rcv-cond-${accId}`).value;
      const note = document.getElementById(`wo-rcv-note-${accId}`).value.trim();
      if (!condition) { this.alert('Mark every accessory OK, damaged or missing', 'error'); return; }
      if (condition !== 'ok' && !note) { this.alert('Add a note for each damaged or missing accessory', 'error'); return; }
      accessories.push({ accessory_id: accId, condition, note });
      for (const f of document.getElementById(`wo-rcv-photo-${accId}`).files) fd.append(`acc_photo_${accId}`, f);
    }
    for (const f of itemFiles) fd.append('item_photos', f);
    fd.append('accessories', JSON.stringify(accessories));
    fd.append('notes', document.getElementById('wo-rcv-notes').value.trim());
    fd.append('at', at);
    const btn = document.getElementById('wo-rcv-btn');
    btn.disabled = true; btn.textContent = 'Uploading...';
    try {
      const res = await fetch(`/api/work-orders/${id}/movements/receive`, { method: 'POST', body: fd });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Receive failed'); }
      this.closeModal();
      this.alert(`Received at ${this._woLocLabel(at)}`);
      await this._woAfterMove(id);
    } catch(e) { this.alert(e.message, 'error'); btn.disabled = false; btn.textContent = 'Receive'; }
  },

  async _woAfterMove(id) {
    if (this._woMoveFrom === 'view') return this.viewWorkOrder(id);
    if (this.section === 'work-orders') return this.loadWorkOrders();
  },

  // Work Orders → Item Movements tab: everything waiting to be sent or received, by location
  async _renderWOMovements() {
    const el = document.getElementById('wo-content');
    const at = this._woMoveAt || '';
    const rows = await this.api('GET', `/work-orders?view=movements${at ? `&at=${at}` : ''}`);
    if (!document.getElementById('wo-content')) return;
    const opts = [['', 'Everywhere'], ['store', 'Stores'], ['warehouse', 'Warehouse'], ['service_center', 'Service Center']];
    el.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <label style="font-size:13px;margin:0">To do at</label>
        <select id="wo-move-at" style="width:auto" onchange="App._woMoveAt = this.value; App._renderWOMovements()">${opts.map(([v, l]) => `<option value="${v}" ${v === at ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span style="font-size:12px;color:var(--text-muted)">Items to send on, or on their way in to be received with photos and an accessory check.</span>
      </div>
      ${!rows.length ? '<div class="empty-state"><p>Nothing to send or receive.</p></div>' : `<div class="table-wrap"><table class="table">
        <thead><tr><th>WO #</th><th>Customer</th><th>Item</th><th>Status</th><th>Where</th><th></th></tr></thead>
        <tbody>${rows.map(wo => `<tr>
          <td class="fw-600">${wo.wo_number}</td>
          <td>${this.escapeAttr(wo.customer_name || '—')}</td>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escapeAttr(wo.item_label || wo.description)}</td>
          <td><span class="badge-pill ${this._woStatusBadge[wo.status] || 'badge-secondary'}">${this._woStatusLabels[wo.status] || wo.status}</span></td>
          <td>${this._woWhereBadge(wo)}</td>
          <td style="text-align:right;white-space:nowrap">${this._woMoveButton(wo, 'list')} <button class="btn btn-sm btn-outline" onclick="App.viewWorkOrder(${wo.id})">View</button></td>
        </tr>`).join('')}</tbody></table></div>`}`;
  },
});
