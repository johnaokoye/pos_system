// Rentals: agreements, dispatch, deposits, item picker, finalize.
Object.assign(App, {
  // ─── Rentals ──────────────────────────────────────────────────────────────

  _rentalTabs: [
    { key: 'pending',        label: 'Held' },
    { key: 'awaiting_issue', label: 'Awaiting Issue' },
    { key: 'active',         label: 'Active' },
    { key: 'overdue',        label: 'Overdue' },
    { key: 'awaiting_payment', label: 'Returned – Not Paid' },
    { key: 'all',            label: 'All Agreements' },
    { key: 'returned',       label: 'Returned' },
    { key: 'cancelled',      label: 'Cancelled' },
    { key: 'maintenance',    label: 'In Maintenance' },
    { key: 'out_of_service', label: 'Out of Service' },
  ],

  async renderRentals() {
    this.rentalTab = this.rentalTab || 'active';
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Rentals</h2>
        <div id="rental-header-actions"></div>
      </div>
      <div id="rental-drawer-banner" style="display:none;align-items:center;gap:14px;padding:10px 16px;margin-bottom:14px;background:#fff8e1;border:2px solid #ffc107;border-radius:8px">
        <svg viewBox="0 0 24 24" fill="#f59e0b" width="20" height="20"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
        <span style="font-size:14px;font-weight:500;color:#7c5c00">No cash drawer is open — rental checkouts/returns won't be tied to a drawer for reconciliation.</span>
        <button class="btn btn-sm" style="background:#f59e0b;color:#fff;font-weight:600;border:none;padding:5px 14px" onclick="App.checkPOSDrawer()">Open Drawer</button>
      </div>
      <div class="crm-tabs" id="rental-tabs-nav">
        ${this._rentalTabs.map(t=>`<button class="crm-tab ${this.rentalTab===t.key?'active':''}" onclick="App.filterRentals('${t.key}')">${t.label}</button>`).join('')}
      </div>
      <div id="rental-content"></div>`;
    await this.checkPOSDrawer();
    this.renderRentalDrawerBanner();
    await this.loadRentalTab();
  },

  renderRentalDrawerBanner() {
    const banner = document.getElementById('rental-drawer-banner');
    if (banner) banner.style.display = (!this.currentDrawerSession && this._posHasDrawers) ? 'flex' : 'none';
  },

  async filterRentals(tab) {
    this.rentalTab = tab;
    document.querySelectorAll('#rental-tabs-nav .crm-tab').forEach((btn,i) => {
      btn.classList.toggle('active', this._rentalTabs[i].key === tab);
    });
    await this.loadRentalTab();
  },

  async loadRentalTab() {
    const hdr = document.getElementById('rental-header-actions');
    if (hdr) hdr.innerHTML = `${this.can('quotations') ? `<button class="btn btn-secondary btn-sm" style="margin-right:8px" onclick="App.showQuoteForm(null,'rental')">Rental Quote</button>` : ''}${this.can('rentals_issue') ? `<button class="btn btn-secondary btn-sm" style="margin-right:8px" onclick="App.showSection('rental-dispatch')">Rental Dispatch</button>` : ''}${this.can('rentals_checkout') ? `<button class="btn btn-primary btn-sm" onclick="App.showRentalCheckoutModal()">+ New Rental</button>` : ''}`;
    if (this.rentalTab === 'out_of_service') await this.loadRentalOutOfService();
    else if (this.rentalTab === 'maintenance') await this.loadRentalMaintenance();
    else await this.loadRentalAgreements();
  },

  // Rental units held out of service — today that's the faulty unit from an
  // item replacement (see showReplaceRentalItemModal). They don't count as
  // available anywhere until returned to service here.
  async loadRentalOutOfService() {
    const el = document.getElementById('rental-content');
    if (!el) return;
    const showAll = !!this._oosShowAll;
    const rows = await this.api('GET', `/rentals/out-of-service${showAll ? '?status=all' : ''}`);
    if (!document.getElementById('rental-content') || this.rentalTab !== 'out_of_service') return;
    const toggle = `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px"><input type="checkbox" ${showAll ? 'checked' : ''} onchange="App._oosShowAll=this.checked;App.loadRentalOutOfService()" style="width:auto;margin:0"> Include units already returned to service</label>`;
    el.innerHTML = toggle + (!rows.length ? '<div class="empty-state"><p>No rental units are out of service.</p></div>' : `
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Item</th><th>Qty</th><th>Branch</th><th>Reason</th><th>Agreement</th><th>Since</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td class="fw-600">${r.product_name || '—'}${r.sku ? `<div style="font-size:11px;color:var(--text-muted);font-family:monospace">${r.sku}</div>` : ''}</td>
          <td>${r.quantity}</td>
          <td>${r.branch_name || '—'}</td>
          <td style="font-size:12px;max-width:320px">${r.reason || '—'}</td>
          <td>${r.agreement_id ? `<a href="#" onclick="event.preventDefault();App.viewRentalAgreement(${r.agreement_id})">${r.agreement_number}</a>` : '—'}</td>
          <td style="font-size:12px">${this.fmtDateTime(r.created_at)}${r.created_by_name ? `<div style="color:var(--text-muted)">${r.created_by_name}</div>` : ''}</td>
          <td>${r.returned_to_service_at ? `<span class="badge-pill badge-success">Returned ${this.fmtDate(r.returned_to_service_at)}</span>${r.returned_to_service_by_name ? `<div style="font-size:11px;color:var(--text-muted)">${r.returned_to_service_by_name}</div>` : ''}` : '<span class="badge-pill badge-warning">Out of service</span>'}</td>
          <td>${r.returned_to_service_at ? '' : `<button class="btn btn-sm btn-primary" onclick="App.returnRentalUnitToService(${r.id})">Return to Service</button>`}</td>
        </tr>`).join('')}</tbody>
      </table>
      </div>`);
  },

  // Items taken in for maintenance/repair/servicing on a paused rental (see
  // showPauseRentalModal), each with its work log.
  _maintLogLabels: { issue: 'Issue found', work: 'Work done', parts: 'Parts', note: 'Note', completed: 'Completed' },

  async loadRentalMaintenance() {
    const el = document.getElementById('rental-content');
    if (!el) return;
    const showAll = !!this._maintShowAll;
    const rows = await this.api('GET', `/rentals/maintenance${showAll ? '?status=all' : ''}`);
    if (!document.getElementById('rental-content') || this.rentalTab !== 'maintenance') return;
    const toggle = `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px"><input type="checkbox" ${showAll ? 'checked' : ''} onchange="App._maintShowAll=this.checked;App.loadRentalMaintenance()" style="width:auto;margin:0"> Include completed maintenance</label>`;
    const days = r => Math.max(0, Math.floor(((r.completed_at ? new Date(r.completed_at) : new Date()) - new Date(String(r.opened_at).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(r.opened_at) ? '' : 'Z'))) / 86400000));
    el.innerHTML = toggle + (!rows.length ? `<div class="empty-state"><p>${showAll ? 'No maintenance recorded yet.' : 'No rental items are in maintenance.'}</p></div>` : `
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Item</th><th>Qty</th><th>Reason</th><th>Agreement</th><th>Customer</th><th>Branch</th><th>In Since</th><th>Latest Entry</th><th>Cost</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td class="fw-600">${r.product_name || '—'}${r.sku ? `<div style="font-size:11px;color:var(--text-muted);font-family:monospace">${r.sku}</div>` : ''}</td>
          <td>${r.quantity}</td>
          <td style="text-transform:capitalize">${r.reason}</td>
          <td><a href="#" onclick="event.preventDefault();App.viewRentalAgreement(${r.agreement_id})">${r.agreement_number}</a></td>
          <td>${r.customer_name || '—'}</td>
          <td>${r.branch_name || '—'}</td>
          <td style="font-size:12px">${this.fmtDateTime(r.opened_at)}<div style="color:var(--text-muted)">${days(r)} day${days(r) === 1 ? '' : 's'}${r.opened_by_name ? ` · ${r.opened_by_name}` : ''}</div></td>
          <td style="font-size:12px;max-width:280px">${r.last_log_notes ? this.escapeAttr(r.last_log_notes) : '—'}<div style="color:var(--text-muted)">${r.log_count} entr${r.log_count === 1 ? 'y' : 'ies'}</div></td>
          <td>${r.total_cost > 0 ? this.fmt(r.total_cost) : '—'}</td>
          <td>${r.status === 'open' ? '<span class="badge-pill badge-warning">In maintenance</span>' : `<span class="badge-pill badge-success">Completed ${this.fmtDate(r.completed_at)}</span>`}</td>
          <td style="white-space:nowrap"><button class="btn btn-sm btn-outline" onclick="App.showRentalMaintenance(${r.id})">${r.status === 'open' ? 'Log / Update' : 'View Log'}</button></td>
        </tr>`).join('')}</tbody>
      </table>
      </div>`);
  },

  async showRentalMaintenance(id) {
    const m = await this.api('GET', `/rentals/maintenance/${id}`);
    const open = m.status === 'open';
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">${m.product_name} — ${m.reason.charAt(0).toUpperCase() + m.reason.slice(1)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="max-height:72vh;overflow-y:auto">
          <div style="font-size:13px;margin-bottom:12px;line-height:1.6">
            <strong>Agreement:</strong> <a href="#" onclick="event.preventDefault();App.closeModal();App.viewRentalAgreement(${m.agreement_id})">${m.agreement_number}</a> · ${m.customer_name || '—'} · ${m.branch_name || '—'}<br>
            <strong>Qty:</strong> ${m.quantity}${m.sku ? ` · <span style="font-family:monospace">${m.sku}</span>` : ''} · <strong>In since</strong> ${this.fmtDateTime(m.opened_at)}${m.opened_by_name ? ` by ${m.opened_by_name}` : ''}<br>
            <strong>Status:</strong> ${open ? '<span class="badge-pill badge-warning">In maintenance</span>' : `<span class="badge-pill badge-success">Completed</span> ${this.fmtDateTime(m.completed_at)}${m.completed_by_name ? ` by ${m.completed_by_name}` : ''}`}
            ${m.total_cost > 0 ? ` · <strong>Cost so far:</strong> ${this.fmt(m.total_cost)}` : ''}
          </div>
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Work Log</div>
          <div style="border:1px solid var(--border);border-radius:6px;margin-bottom:14px">
            ${m.log.map((l, i) => `<div style="padding:8px 12px;${i ? 'border-top:1px solid var(--border);' : ''}font-size:13px">
              <div style="display:flex;justify-content:space-between;gap:8px"><strong>${this._maintLogLabels[l.entry_type] || l.entry_type}${l.cost != null ? ` · ${this.fmt(l.cost)}` : ''}</strong><span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${this.fmtDateTime(l.created_at)}${l.employee_name ? ` · ${l.employee_name}` : ''}</span></div>
              <div style="white-space:pre-wrap;overflow-wrap:anywhere">${this.escapeAttr(l.notes)}</div>
            </div>`).join('')}
          </div>
          ${open ? `<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Add to Log</div>
          <div class="input-row">
            <div class="form-group"><label>Type</label><select id="ml-type">
              ${['issue', 'work', 'parts', 'note'].map(t => `<option value="${t}" ${t === 'work' ? 'selected' : ''}>${this._maintLogLabels[t]}</option>`).join('')}
            </select></div>
            <div class="form-group"><label>Cost (optional)</label><input id="ml-cost" type="number" min="0" step="0.01" placeholder="0.00"></div>
          </div>
          <div class="form-group"><label>Details</label><textarea id="ml-notes" rows="3" style="width:100%;resize:vertical" placeholder="What was found, what was done, parts used…"></textarea></div>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          ${open ? `<button class="btn btn-outline" onclick="App.completeRentalMaintenance(${m.id})">Mark Complete</button>
          <button class="btn btn-primary" onclick="App.addRentalMaintenanceLog(${m.id})">Add Entry</button>` : ''}
        </div>
      </div>`);
  },

  async addRentalMaintenanceLog(id) {
    const notes = document.getElementById('ml-notes').value.trim();
    if (!notes) { this.alert('Describe the issue or work done', 'error'); return; }
    try {
      await this.api('POST', `/rentals/maintenance/${id}/log`, { entry_type: document.getElementById('ml-type').value, notes, cost: document.getElementById('ml-cost').value, employee_id: this.currentUser.id });
      this.alert('Entry added');
      await this.showRentalMaintenance(id);
      if (this.rentalTab === 'maintenance') this.loadRentalMaintenance();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async completeRentalMaintenance(id) {
    const notes = document.getElementById('ml-notes')?.value.trim();
    if (!confirm('Mark this maintenance complete? The item is ready to go back out. (Resume the rental to restart its billing clock.)')) return;
    try {
      await this.api('PATCH', `/rentals/maintenance/${id}/complete`, { notes, employee_id: this.currentUser.id });
      this.alert('Maintenance completed');
      await this.showRentalMaintenance(id);
      if (this.rentalTab === 'maintenance') this.loadRentalMaintenance();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async returnRentalUnitToService(id) {
    if (!confirm('Return this unit to service? It will show as available to rent again.')) return;
    try {
      await this.api('PATCH', `/rentals/out-of-service/${id}/return-to-service`, { employee_id: this.currentUser.id });
      this.alert('Returned to service');
      this.loadRentalOutOfService();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Dispatch (standalone page — left-pane link + "Rental Dispatch" button
  // on the Rentals screen) ────────────────────────────────────────────────
  // A focused queue for whoever physically hands rentals over: what's paid
  // and waiting to go out, and what's already gone out. Reuses the same
  // GET /rentals/agreements?view= endpoint the Rentals screen itself uses.

  _dispatchTabs: [
    { key: 'schedule',          label: 'Schedule' },
    { key: 'awaiting_issue',    label: 'Awaiting Issue' },
    { key: 'active',            label: 'Issued' },
    { key: 'deliveries',        label: 'Deliveries' },
    { key: 'pickup_reminders',  label: 'Pickup Reminders' },
  ],

  async renderRentalDispatch() {
    this.dispatchTab = this.dispatchTab || 'schedule';
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Rental Dispatch</h2>
      </div>
      <div class="crm-tabs" id="dispatch-tabs-nav">
        ${this._dispatchTabs.map(t=>`<button class="crm-tab ${this.dispatchTab===t.key?'active':''}" onclick="App.filterDispatch('${t.key}')">${t.label}</button>`).join('')}
      </div>
      <div id="dispatch-content"></div>`;
    await this.loadDispatchTab();
  },

  async filterDispatch(tab) {
    this.dispatchTab = tab;
    document.querySelectorAll('#dispatch-tabs-nav .crm-tab').forEach((btn,i) => {
      btn.classList.toggle('active', this._dispatchTabs[i].key === tab);
    });
    await this.loadDispatchTab();
  },

  async loadDispatchTab() {
    if (this.dispatchTab === 'schedule') return this.loadDispatchScheduleTab();
    if (this.dispatchTab === 'deliveries') return this.loadDeliveriesTab();
    if (this.dispatchTab === 'pickup_reminders') return this.loadPickupRemindersTab();
    const el = document.getElementById('dispatch-content');
    if (!el) return;
    const agreements = await this.api('GET', `/rentals/agreements?view=${this.dispatchTab}`);
    if (!document.getElementById('dispatch-content')) return;
    const sc = { out_for_delivery:'badge-teal', awaiting_issue:'badge-warning', active:'badge-info' };
    const notAssigned = '<span style="color:var(--text-muted)">Not yet assigned</span>';
    const notApplicable = '<span style="color:var(--text-muted)">—</span>';
    const customerPickupTag = '<span class="badge-pill badge-secondary" style="font-size:11px">Customer Pickup</span>';
    document.getElementById('dispatch-content').innerHTML = !agreements.length ? '<div class="empty-state"><p>Nothing here.</p></div>' : `
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Agreement #</th><th>Customer</th><th>Branch</th><th>Deposit Collected</th><th>Due Date</th><th>Delivery</th><th>Operator</th><th>Status</th><th></th></tr></thead>
        <tbody>${agreements.map(a => `<tr>
          <td class="fw-600">${a.agreement_number}</td>
          <td>${a.customer_name||'—'}</td>
          <td>${a.branch_name||'—'}</td>
          <td>${a.deposit_total ? this.fmt(a.deposit_total) : '—'}</td>
          <td>${this.fmtDate(a.due_date)}</td>
          <td>${a.delivery_required ? (a.delivery_driver_name || notAssigned) : (a.customer_pickup ? customerPickupTag : notApplicable)}</td>
          <td>${a.operator_required ? (a.operator_name || notAssigned) : notApplicable}</td>
          <td><span class="badge-pill ${sc[a.display_status]||'badge-secondary'}">${a.display_status}</span></td>
          <td style="text-align:right;white-space:nowrap">
            ${a.status==='awaiting_issue' && this.can('rentals_issue') ? `<button class="btn btn-sm btn-primary" onclick="App.showIssueRentalModal(${a.id})">Issue</button>` : ''}
            ${a.status==='active' ? `<button class="btn btn-sm btn-outline" onclick="App.printRentalDeliveryNote(${a.id})">🖨️ Delivery Note</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
      </table>
      </div>`;
  },

  // Route sheet for whoever's driving/operating — every job still relevant
  // to dispatch (paid-and-waiting, or already handed over) that needs
  // delivery, pickup (return leg), or an operator, with the from/to addresses
  // and item list needed to actually run it. Delivery Date mirrors the
  // agreement's checkout_date (when the item goes/went out); Pickup Date
  // mirrors due_date (when it's scheduled to be collected back) — same
  // fields the rental agreement itself is billed against.
  // ─── Dispatch schedule ─────────────────────────────────────────────────
  // Deliveries and pickups booked for a date range, by day, with the open
  // jobs nobody has booked yet at the top (GET /rentals/dispatch-schedule).
  _localDate(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; },

  _dispatchRange() {
    const today = new Date();
    const add = n => { const d = new Date(today); d.setDate(d.getDate() + n); return this._localDate(d); };
    const preset = this._dispatchPreset || 'week';
    if (preset === 'today') return { from: add(0), to: add(0) };
    if (preset === 'tomorrow') return { from: add(1), to: add(1) };
    if (preset === 'custom') return { from: this._dispatchFrom || add(0), to: this._dispatchTo || add(6) };
    return { from: add(0), to: add(6) };
  },

  async loadDispatchScheduleTab() {
    const el = document.getElementById('dispatch-content');
    if (!el) return;
    if (!this._dispatchDrivers) {
      try { this._dispatchDrivers = (await this.api('GET', '/employees')).filter(e => e.is_driver && e.active !== 0); } catch(e) { this._dispatchDrivers = []; }
    }
    const { from, to } = this._dispatchRange();
    const driver = this._dispatchDriver || '';
    let data;
    try { data = await this.api('GET', `/rentals/dispatch-schedule?from=${from}&to=${to}${driver ? `&driver_id=${driver}` : ''}`); }
    catch(e) { el.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (this.dispatchTab !== 'schedule' || !document.getElementById('dispatch-content')) return;
    const canSchedule = this.can('rentals_issue');
    const legBadge = leg => leg === 'delivery' ? '<span class="badge-pill badge-info" style="font-size:10px">DELIVERY</span>' : '<span class="badge-pill badge-warning" style="font-size:10px">PICKUP</span>';
    const stateBadge = { done: '<span class="badge-pill badge-success">Done</span>', out: '<span class="badge-pill badge-teal">Out for delivery</span>', late: '<span class="badge-pill badge-danger">Late</span>', pending: '<span class="badge-pill badge-secondary">Booked</span>' };
    const time = d => this._toDate(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: this._storeTz() });
    const addr = j => j.leg === 'delivery' ? (j.agreement.delivery_address || this._rentalPickupAddress(j.agreement) || '—') : (this._rentalPickupAddress(j.agreement) || '—');
    const row = (j, withTime) => `<tr>
      ${withTime ? `<td style="white-space:nowrap" class="fw-600">${time(j.start)}${j.end ? ` – ${time(j.end)}` : ''}</td>` : `<td style="white-space:nowrap;font-size:12px">Due ${this.fmtDate(j.agreement.due_date)}</td>`}
      <td>${legBadge(j.leg)}</td>
      <td class="fw-600">${j.agreement.agreement_number}</td>
      <td>${j.agreement.customer_name || '—'}${j.agreement.customer_phone ? `<div style="font-size:11px"><a href="tel:${j.agreement.customer_phone}">${j.agreement.customer_phone}</a></div>` : ''}</td>
      <td style="font-size:12px;max-width:220px">${addr(j)}</td>
      <td style="font-size:12px;max-width:180px">${j.agreement.item_summary || '—'}</td>
      <td>${j.driver_name || '<span style="color:var(--text-muted)">Unassigned</span>'}</td>
      <td>${withTime ? (stateBadge[j.state] || '') : ''}${j.notes ? `<div style="font-size:11px;color:var(--text-muted);max-width:180px">${this.escapeAttr(j.notes)}</div>` : ''}</td>
      <td style="text-align:right;white-space:nowrap">${canSchedule && j.state !== 'done' && j.open ? `<button class="btn btn-sm ${withTime ? 'btn-outline' : 'btn-primary'}" onclick="App.showScheduleDispatchModal(${j.agreement.id},'${j.leg}')">${withTime ? 'Reschedule' : 'Schedule'}</button>` : ''}</td>
    </tr>`;
    const head = first => `<thead><tr><th>${first}</th><th>Job</th><th>Agreement</th><th>Customer</th><th>Address</th><th>Items</th><th>Driver</th><th>Status</th><th></th></tr></thead>`;
    const byDay = {};
    for (const j of data.scheduled) { const k = this._localDate(new Date(j.start)); (byDay[k] = byDay[k] || []).push(j); }
    const days = Object.keys(byDay).sort();
    el.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        <select id="ds-preset" onchange="App._dispatchPreset=this.value;App.loadDispatchScheduleTab()" style="width:150px">
          ${[['today','Today'],['tomorrow','Tomorrow'],['week','Next 7 days'],['custom','Choose dates…']].map(([v,l]) => `<option value="${v}" ${(this._dispatchPreset||'week')===v?'selected':''}>${l}</option>`).join('')}
        </select>
        ${(this._dispatchPreset||'week') === 'custom' ? `<input type="date" value="${from}" onchange="App._dispatchFrom=this.value;App.loadDispatchScheduleTab()" style="width:150px"> to <input type="date" value="${to}" onchange="App._dispatchTo=this.value;App.loadDispatchScheduleTab()" style="width:150px">` : `<span style="font-size:13px;color:var(--text-muted)">${this.fmtDate(from + 'T12:00:00')}${from !== to ? ` – ${this.fmtDate(to + 'T12:00:00')}` : ''}</span>`}
        <select onchange="App._dispatchDriver=this.value;App.loadDispatchScheduleTab()" style="width:180px">
          <option value="">All drivers</option>
          ${this._dispatchDrivers.map(d => `<option value="${d.id}" ${String(driver)===String(d.id)?'selected':''}>${d.first_name} ${d.last_name}</option>`).join('')}
        </select>
      </div>
      ${data.unscheduled.length ? `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--warning,#d97706)">
        <div class="card-header"><span class="card-title">Needs Scheduling (${data.unscheduled.length})</span></div>
        <div class="table-wrap"><table class="table">${head('Due')}<tbody>${data.unscheduled.map(j => row(j, false)).join('')}</tbody></table></div>
      </div>` : ''}
      ${days.length ? days.map(d => `<div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">${new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span><span style="font-size:12px;color:var(--text-muted)">${byDay[d].length} job${byDay[d].length === 1 ? '' : 's'}</span></div>
        <div class="table-wrap"><table class="table">${head('Time')}<tbody>${byDay[d].map(j => row(j, true)).join('')}</tbody></table></div>
      </div>`).join('') : `<div class="empty-state"><p>No deliveries or pickups booked for these dates${driver ? ' for this driver' : ''}.</p></div>`}`;
  },

  async showScheduleDispatchModal(id, leg) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    if (!this._dispatchDrivers) {
      try { this._dispatchDrivers = (await this.api('GET', '/employees')).filter(e => e.is_driver && e.active !== 0); } catch(e) { this._dispatchDrivers = []; }
    }
    const isDelivery = leg === 'delivery';
    const start = a[`${leg}_scheduled_start`] ? new Date(a[`${leg}_scheduled_start`]) : null;
    const end = a[`${leg}_scheduled_end`] ? new Date(a[`${leg}_scheduled_end`]) : null;
    const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const defDate = start ? this._localDate(start) : isDelivery ? this._localDate(new Date()) : String(a.due_date).slice(0, 10);
    const driverId = isDelivery ? a.delivery_driver_id : a.pickup_driver_id;
    const lockedDriver = isDelivery && a.delivery_driver_confirmed_at;
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Schedule ${isDelivery ? 'Delivery' : 'Pickup'} — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
            ${a.customer_name || '—'} · ${a.items.filter(i => !i.parent_item_id).map(i => `${i.product_name} ×${i.quantity}`).join(', ')}<br>
            📍 ${(isDelivery ? a.delivery_address : this._rentalPickupAddress(a)) || 'No address on file'}<br>
            Due back ${this.fmtDate(a.due_date)}
          </div>
          <div class="form-group"><label>Date</label><input type="date" id="sd-date" value="${defDate}"></div>
          <div class="input-row">
            <div class="form-group"><label>From</label><input type="time" id="sd-start" value="${start ? hhmm(start) : '09:00'}"></div>
            <div class="form-group"><label>To <span style="color:var(--text-muted);font-weight:400;font-size:11px">(optional)</span></label><input type="time" id="sd-end" value="${end ? hhmm(end) : ''}"></div>
          </div>
          <div class="form-group"><label>Driver</label>
            <select id="sd-driver" ${lockedDriver ? 'disabled' : ''}>
              <option value="">— Assign later —</option>
              ${this._dispatchDrivers.map(d => `<option value="${d.id}" ${String(driverId) === String(d.id) ? 'selected' : ''}>${d.first_name} ${d.last_name}</option>`).join('')}
            </select>
            ${lockedDriver ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">The driver has already signed for this delivery.</div>` : !this._dispatchDrivers.length ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">No employees are flagged as a driver yet (Employees → edit → Driver checkbox).</div>` : ''}
          </div>
          <div class="form-group"><label>Notes for the driver</label><textarea id="sd-notes" rows="2" style="width:100%;resize:vertical" placeholder="Gate code, contact on site, access…">${this.escapeAttr(a[`${leg}_schedule_notes`] || '')}</textarea></div>
        </div>
        <div class="modal-footer">
          ${start ? `<button class="btn btn-outline" onclick="App.saveScheduleDispatch(${id},'${leg}',true)">Unschedule</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveScheduleDispatch(${id},'${leg}')">Save</button>
        </div>
      </div>`);
  },

  async saveScheduleDispatch(id, leg, clear = false) {
    const body = { leg, clear };
    if (!clear) {
      const date = document.getElementById('sd-date').value;
      const st = document.getElementById('sd-start').value;
      const en = document.getElementById('sd-end').value;
      if (!date || !st) { this.alert('Choose the date and start time', 'error'); return; }
      body.start = new Date(`${date}T${st}`).toISOString();
      body.end = en ? new Date(`${date}T${en}`).toISOString() : null;
      const drv = document.getElementById('sd-driver');
      if (drv && !drv.disabled && drv.value) body.driver_id = parseInt(drv.value);
      body.notes = document.getElementById('sd-notes').value;
    }
    try {
      const r = await this.api('PATCH', `/rentals/agreements/${id}/schedule-dispatch`, body);
      this.closeModal();
      this.alert(clear ? `${leg === 'delivery' ? 'Delivery' : 'Pickup'} unscheduled` : `${leg === 'delivery' ? 'Delivery' : 'Pickup'} scheduled`);
      for (const w of r.warnings || []) {
        this.alert(w.type === 'driver_busy'
          ? `Heads up: this driver also has the ${w.leg} for ${w.agreement_number} at ${this.fmtDateTime(w.at)}`
          : `Heads up: this pickup is after the rental is due back (${this.fmtDate(w.due_date + 'T12:00:00')}) — time past the due date is billed as late unless the rental is paused`, 'warning');
      }
      if (this.section === 'rental-dispatch') this.loadDispatchTab();
      else if (this.section === 'rentals') this.renderRentals();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Agreement view: when its delivery / pickup is booked, with Schedule buttons.
  _dispatchScheduleHtml(a) {
    if (!a.delivery_required && !a.pickup_required) return '';
    const canSchedule = this.can('rentals_issue');
    const time = (s, e) => `${this.fmtDateTime(s)}${e ? ` – ${this._toDate(e).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: this._storeTz() })}` : ''}`;
    const line = (leg, label, open, doneText) => {
      const s = a[`${leg}_scheduled_start`], e = a[`${leg}_scheduled_end`];
      const driver = leg === 'delivery' ? a.delivery_driver_name : a.pickup_driver_name;
      return `<div style="margin-top:4px;display:flex;justify-content:space-between;gap:8px;align-items:center">
        <span><strong>${label}:</strong> ${doneText || (s ? `${time(s, e)}${driver ? ` · ${driver}` : ' · driver not assigned'}${a[`${leg}_schedule_notes`] ? ` <span style="color:var(--text-muted)">· ${this.escapeAttr(a[`${leg}_schedule_notes`])}</span>` : ''}` : '<span style="color:var(--warning,#d97706)">not scheduled</span>')}</span>
        ${canSchedule && open && !doneText ? `<button class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.closeModal();App.showScheduleDispatchModal(${a.id},'${leg}')">${s ? 'Reschedule' : 'Schedule'}</button>` : ''}
      </div>`;
    };
    return `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px">
      <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Dispatch</strong>
      ${a.delivery_required ? line('delivery', 'Delivery', ['pending', 'awaiting_issue'].includes(a.status), ['active', 'returned'].includes(a.status) ? `delivered ${a.checkout_datetime ? this.fmtDateTime(a.checkout_datetime) : ''}` : '') : ''}
      ${a.pickup_required ? line('pickup', 'Pickup', ['pending', 'awaiting_issue', 'active'].includes(a.status), a.pickup_confirmed_at ? `collected ${this.fmtDateTime(a.pickup_confirmed_at)}` : a.status === 'returned' ? 'returned' : '') : ''}
    </div>`;
  },

  async loadDeliveriesTab() {
    const el = document.getElementById('dispatch-content');
    if (!el) return;
    const [awaitingIssue, active] = await Promise.all([
      this.api('GET', '/rentals/agreements?view=awaiting_issue'),
      this.api('GET', '/rentals/agreements?view=active'),
    ]);
    const deliveries = [...awaitingIssue, ...active].filter(a => a.delivery_required || a.pickup_required || a.operator_required);
    if (!document.getElementById('dispatch-content')) return;
    const sc = { out_for_delivery:'badge-teal', awaiting_issue:'badge-warning', active:'badge-info' };
    const none = '<span style="color:var(--text-muted)">None</span>';
    const notAssigned = '<span style="color:var(--text-muted)">Not yet assigned</span>';
    const fromAddr = a => [a.branch_name, a.branch_address, [a.branch_city, a.branch_state, a.branch_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const toAddr = a => this._rentalPickupAddress(a) || '—';
    document.getElementById('dispatch-content').innerHTML = !deliveries.length ? '<div class="empty-state"><p>No deliveries, pickups, or operator jobs to show.</p></div>' : `
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Agreement #</th><th>Customer</th><th>Items</th><th>Route</th><th>Delivery</th><th>Delivery Date</th><th>Pickup</th><th>Pickup Date</th><th>Operator</th><th>Status</th><th></th></tr></thead>
        <tbody>${deliveries.map(a => `<tr>
          <td class="fw-600">${a.agreement_number}</td>
          <td>${a.customer_name||'—'}</td>
          <td style="max-width:200px">${a.item_summary||'—'}</td>
          <td style="max-width:220px">${a.delivery_required ? `${fromAddr(a)||'—'} → ${toAddr(a)}` : '—'}</td>
          <td>${a.delivery_required ? (a.delivery_driver_name || notAssigned) : none}</td>
          <td>${a.delivery_required ? (a.checkout_date && a.status==='active' ? this.fmtDate(a.checkout_date) : a.delivery_scheduled_start ? `<span title="Scheduled">🗓 ${this.fmtDateTime(a.delivery_scheduled_start)}</span>` : '<span style="color:var(--text-muted)">Not scheduled</span>') : none}</td>
          <td>${this._pickupDriverCell(a)}</td>
          <td>${a.pickup_required ? (a.pickup_scheduled_start ? `<span title="Scheduled">🗓 ${this.fmtDateTime(a.pickup_scheduled_start)}</span>` : `Due ${this.fmtDate(a.due_date)}`) : none}</td>
          <td>${a.operator_required ? (a.operator_name || notAssigned) : none}</td>
          <td><span class="badge-pill ${sc[a.display_status]||'badge-secondary'}">${a.display_status}</span></td>
          <td style="text-align:right;white-space:nowrap">
            ${a.status==='awaiting_issue' && this.can('rentals_issue') ? `<button class="btn btn-sm btn-primary" onclick="App.showIssueRentalModal(${a.id})">Issue</button>` : ''}
            ${a.status==='active' ? `<button class="btn btn-sm btn-outline" onclick="App.printRentalDeliveryNote(${a.id})">🖨️ Delivery Note</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
      </table>
      </div>`;
  },

  // Highlighted "about to miss a pickup" queue — GET /rentals/agreements/
  // pickup-reminders does the bucketing (due_8h / due_24h / overdue) live off
  // each agreement's actual due date+time, not just the day. 'overdue' should
  // only flash briefly here before server.js's missed-pickup check auto-
  // pauses it (which drops it out of this list into the pause/contact
  // workflow on the agreement itself).
  async loadPickupRemindersTab() {
    const el = document.getElementById('dispatch-content');
    if (!el) return;
    const reminders = await this.api('GET', '/rentals/agreements/pickup-reminders');
    if (!document.getElementById('dispatch-content')) return;
    const bucketStyle = { overdue: 'background:rgba(220,38,38,0.12);color:#991b1b', due_8h: 'background:rgba(220,38,38,0.08);color:#991b1b', due_24h: 'background:rgba(217,119,6,0.08);color:#92400e' };
    const bucketLabel = { overdue: 'OVERDUE', due_8h: 'Due within 8h', due_24h: 'Due within 24h' };
    document.getElementById('dispatch-content').innerHTML = !reminders.length ? '<div class="empty-state"><p>No pickups due within the next 24 hours.</p></div>' : `
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Pickup-required rentals approaching their due date/time. Overdue ones are auto-paused shortly after — contact the customer from the agreement once that happens.</p>
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Agreement #</th><th>Customer</th><th>Phone</th><th>Item(s)</th><th>Due</th><th>Status</th><th></th></tr></thead>
        <tbody>${reminders.map(a => `<tr style="${bucketStyle[a.bucket]||''}">
          <td class="fw-600">${a.agreement_number}</td>
          <td>${a.customer_name||'—'}</td>
          <td>${a.customer_phone ? `<a href="tel:${a.customer_phone}">${a.customer_phone}</a>` : '—'}</td>
          <td style="max-width:200px">${a.item_summary||'—'}</td>
          <td>${this.fmtDateTime(a.due_datetime)}</td>
          <td><span class="badge-pill" style="${bucketStyle[a.bucket]||''}">${bucketLabel[a.bucket]||a.bucket}</span></td>
          <td></td>
        </tr>`).join('')}</tbody>
      </table>
      </div>`;
  },

  // Standalone page (Sales hub tile, next to Rentals) — previously the
  // "Rental Items" tab inside Rentals, then briefly a Warehouse hub tile;
  // moved into Sales so a rentals-only security group (gated on `rentals`
  // alone, same as this tile) never has to be granted the broader
  // Warehouse hub just to reach it.
  // Rental Items filter bar as it stands, so a save / deactivate re-renders on
  // the same item and branch; `fallback` fills the search and branch only
  // when they were empty.
  _riFilterState(fallback = {}) {
    const val = id => (document.getElementById(id) || {}).value || '';
    return {
      search: val('ri-search') || fallback.search || '',
      branch: val('ri-branch-filter') || (fallback.branchId ? String(fallback.branchId) : ''),
      type: val('ri-type-filter'),
    };
  },

  async renderRentalItems(filters = null) {
    const branches = await this.api('GET', '/branches');
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Rental Items</h2>
        <div id="rental-header-actions" style="display:flex;gap:8px;align-items:center">
          <input id="ri-search" type="text" placeholder="Search name or SKU…" oninput="App._onRentalItemsSearch()" onkeydown="if(event.key==='Enter')App._onRentalItemsSearch(true)" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--card);color:var(--text);width:180px">
          <select id="ri-branch-filter" onchange="App._filterRentalItemsTable()" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--card);color:var(--text)">
            <option value="">All Branches</option>
            <option value="unassigned">Unassigned</option>
            ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
          </select>
          <select id="ri-type-filter" onchange="App._filterRentalItemsTable()" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--card);color:var(--text)">
            <option value="">All Types</option>
            <option value="accessory">Accessories Only</option>
            <option value="item">Exclude Accessories</option>
          </select>
          <button class="btn btn-secondary btn-sm" onclick="App.exportRentalItemsCsv()" title="Export rental items to CSV">&#8659; Export CSV</button>
          ${this.can('rentals_manage_items') ? `
          <a class="btn btn-secondary btn-sm" href="/api/products/export/rentals/template" download title="Download import template">&#8659; Template</a>
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0" title="Import rental items from CSV or Excel">&#8657; Import<input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="display:none" onchange="App.importRentalItemsCsv(this)"></label>
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0" title="Import accessories from the previous system's accessories export (Name + Active). Stock starts at 0.">&#8657; Import Accessories<input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="display:none" onchange="App.importRentalAccessoriesFile(this)"></label>
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0" title="Set accessory counts per location from a file with Accessory (SKU or name), Branch and Quantity columns">&#8657; Import Accessory Counts<input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="display:none" onchange="App.importRentalAccessoryCountsFile(this)"></label>
          <button class="btn btn-secondary btn-sm" onclick="App.showBulkRentalTaxRateModal()" title="Set the tax rate on rental items — all branches or just one">Bulk Tax Rate Change</button>
          <button class="btn btn-primary btn-sm" onclick="App.showRentalItemForm()">+ Add Rental Item</button>` : ''}
        </div>
      </div>
      <div id="rental-content"></div>`;
    if (filters) {
      document.getElementById('ri-search').value = filters.search || '';
      document.getElementById('ri-branch-filter').value = filters.branch || '';
      document.getElementById('ri-type-filter').value = filters.type || '';
    }
    await this.loadRentalItems();
  },

  // Filter once typing pauses rather than rebuilding the table on every
  // keystroke; Enter filters straight away.
  _onRentalItemsSearch(now = false) {
    clearTimeout(this._riSearchTimer);
    if (now) this._filterRentalItemsTable();
    else this._riSearchTimer = setTimeout(() => this._filterRentalItemsTable(), 200);
  },

  exportRentalItemsCsv() {
    const a = document.createElement('a');
    a.href = '/api/products/export/rentals';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  async importRentalItemsCsv(inputEl) {
    const file = inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await this._readImportFile(file); } catch (e) { this.alert(e.message, 'error'); return; }
    const { headers, rows: rawRows } = parsed;
    if (!rawRows.length) { this.alert('No data rows found in CSV', 'error'); return; }

    const mapping = await this._showFieldMappingModal({ title: 'Map Import Columns', headers, fields: this._rentalImportFields });
    if (!mapping) return;
    const rows = this._remapCsvRows(rawRows, mapping);

    await this._runBatchedCsvImport({
      rows, endpoint: '/products/import/rentals', title: 'Importing Rental Items',
      onFinish: () => this.renderRentalItems(),
    });
  },

  // The previous system's accessories export: just a name and an active flag.
  // Creates rental accessories with generated ACC-#### SKUs and 0 stock;
  // names that already exist as accessories only have Active updated.
  async importRentalAccessoriesFile(inputEl) {
    const file = inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await this._readImportFile(file); } catch (e) { this.alert(e.message, 'error'); return; }
    const { headers, rows: rawRows } = parsed;
    if (!rawRows.length) { this.alert('No data rows found in the file', 'error'); return; }

    const mapping = await this._showFieldMappingModal({ title: 'Map Accessory Columns', headers, fields: this._rentalAccessoryImportFields });
    if (!mapping) return;
    const rows = this._remapCsvRows(rawRows, mapping);

    await this._runBatchedCsvImport({
      rows, endpoint: '/products/import/rental-accessories', title: 'Importing Rental Accessories',
      summarize: t => `${t.created||0} accessories created, ${t.updated||0} already existed (Active updated)`,
      onFinish: () => this.renderRentalItems(),
    });
  },

  // Per-location counts for rental accessories: each row sets one
  // accessory's count at one branch (POST /products/import/rental-accessory-stock).
  async importRentalAccessoryCountsFile(inputEl) {
    const file = inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await this._readImportFile(file); } catch (e) { this.alert(e.message, 'error'); return; }
    const { headers, rows: rawRows } = parsed;
    if (!rawRows.length) { this.alert('No data rows found in the file', 'error'); return; }

    const mapping = await this._showFieldMappingModal({ title: 'Map Accessory Count Columns', headers, fields: this._rentalAccessoryCountFields });
    if (!mapping) return;
    const rows = this._remapCsvRows(rawRows, mapping);

    await this._runBatchedCsvImport({
      rows, endpoint: '/products/import/rental-accessory-stock', title: 'Importing Accessory Counts',
      summarize: t => `${t.updated||0} location count(s) set`,
      onFinish: () => this.renderRentalItems(),
    });
  },

  // Rental item form: an accessory gets a count per location instead of the
  // single Branch + Stock Qty pair.
  _toggleRentalAccessoryStock() {
    const isAcc = document.getElementById('rf-is-accessory').checked;
    document.getElementById('rf-branch-wrap').style.display = isAcc ? 'none' : '';
    document.getElementById('rf-stock-wrap').style.display = isAcc ? 'none' : '';
    document.getElementById('rf-acc-stock').style.display = isAcc ? '' : 'none';
  },

  async loadRentalItems() {
    const el = document.getElementById('rental-content');
    if (!el) return;
    this._rentalItemsAll = await this.api('GET', '/products?is_rental=1');
    if (!document.getElementById('rental-content')) return;
    this._filterRentalItemsTable();
  },

  // Re-renders the rental items table from the cached list (this._rentalItemsAll)
  // against the current search/branch filter inputs — no re-fetch, so typing in
  // the search box or switching branches doesn't hit the API on every change.
  _filterRentalItemsTable() {
    const el = document.getElementById('rental-content');
    if (!el || !this._rentalItemsAll) return;
    const branchFilter = document.getElementById('ri-branch-filter')?.value || '';
    const search = (document.getElementById('ri-search')?.value || '').trim().toLowerCase();
    // Accessories can be at several branches (p.branch_stock); everything
    // else is at one (p.assigned_branch_id).
    const atBranch = p => p.branch_stock ? p.branch_stock.some(s => String(s.branch_id) === branchFilter) : String(p.assigned_branch_id) === branchFilter;
    let filtered = !branchFilter ? this._rentalItemsAll
      : branchFilter === 'unassigned' ? this._rentalItemsAll.filter(p => !p.assigned_branch_id)
      : this._rentalItemsAll.filter(atBranch);
    const typeFilter = document.getElementById('ri-type-filter')?.value || '';
    if (typeFilter) filtered = filtered.filter(p => typeFilter === 'accessory' ? p.is_accessory : !p.is_accessory);
    if (search) filtered = filtered.filter(p => p.name.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search));
    // Rows are drawn in batches as the table scrolls (same as Retail
    // Inventory's buildProductTable) — see _riMoreRows.
    this._riTable = { rows: filtered, branchFilter, shown: 0 };
    document.getElementById('rental-content').innerHTML = !filtered.length ? '<div class="empty-state"><p>No rental items match this filter.</p></div>' : `
      <div class="card">
        <div class="table-wrap" id="ri-table-wrap" style="max-height:65vh;overflow-y:auto" onscroll="if(this.scrollTop+this.clientHeight>=this.scrollHeight-400)App._riMoreRows()">
          <table class="sticky-table">
            <thead><tr><th style="width:52px"></th><th>SKU</th><th>Name</th><th>Branch</th><th>Class</th><th>Daily</th><th>Weekly</th><th>Monthly</th><th>Hourly</th><th>Stock</th><th>Available</th><th>Status</th><th></th></tr></thead>
            <tbody id="ri-tbody">${this._riTakeRows()}</tbody>
          </table>
          <div id="ri-more" style="padding:10px;text-align:center;color:var(--text-muted);font-size:12px;${this._riTable.shown < filtered.length ? '' : 'display:none'}">
            Showing <span id="ri-shown">${this._riTable.shown}</span> of ${filtered.length} — scroll for more
          </div>
        </div>
      </div>`;
  },

  _riTakeRows() {
    const t = this._riTable;
    const slice = t.rows.slice(t.shown, t.shown + this.INV_ROW_BATCH);
    t.shown += slice.length;
    return this._riRowsHtml(slice, t.branchFilter);
  },

  _riMoreRows() {
    const t = this._riTable, tbody = document.getElementById('ri-tbody');
    if (!t || !tbody || t.shown >= t.rows.length) return;
    tbody.insertAdjacentHTML('beforeend', this._riTakeRows());
    document.getElementById('ri-shown').textContent = t.shown;
    if (t.shown >= t.rows.length) document.getElementById('ri-more').style.display = 'none';
  },

  _riRowsHtml(rows, branchFilter) {
    return rows.map(p => `<tr>
              <td style="width:52px">${p.image_path ? `<img src="${p.image_path}" class="prod-img-thumb" alt="" loading="lazy" decoding="async">` : `<div class="prod-img-placeholder" onclick="App.showRentalItemForm(${p.id})">📷</div>`}</td>
              <td class="fw-600">${p.sku}${p.is_accessory?' <span class="badge-pill badge-secondary" style="font-size:10px">accessory</span>':''}</td>
              <td>${p.name}${p.rental_allow_sale ? ` <span class="badge-pill badge-teal" style="font-size:10px" title="Also sellable/quotable outright at ${this.fmt(p.price)}">For Sale · ${this.fmt(p.price)}</span>` : ''}${p.online_available ? ` <span class="badge-pill badge-info" style="font-size:10px" title="Visible on the website's Rentals catalog">Online</span>` : ''}</td>
              <td>${p.branch_stock?.length ? p.branch_stock.map(s => `<div style="white-space:nowrap">${s.branch_name}: <span class="fw-600">${s.stock_qty}</span></div>`).join('') : (p.assigned_branch_name || '—')}</td>
              <td><span class="badge-pill ${p.rental_classification==='equipment'?'badge-info':'badge-secondary'}">${p.rental_classification==='equipment'?'Equipment':'Tool'}</span></td>
              <td>${this.fmt(p.rental_rate)}</td>
              <td>${p.rental_classification==='equipment' ? this.fmt(p.rental_weekly_rate) : this.fmt(this._toolTierDayRates(p.rental_rate).weekTierDayRate)+'/day'}</td>
              <td>${p.rental_classification==='equipment' ? this.fmt(p.rental_monthly_rate) : this.fmt(this._toolTierDayRates(p.rental_rate).monthTierDayRate)+'/day'}</td>
              <td>${p.rental_classification==='equipment' ? this.fmt(p.rental_hourly_rate) : '—'}</td>
              <td>${p.stock_qty}</td>
              <td class="${(p.stock_qty - (p.rental_outstanding_qty||0)) <= 0 ? 'color-danger fw-600' : ''}">${p.stock_qty - (p.rental_outstanding_qty||0)}</td>
              <td><span class="badge-pill ${p.active ? 'badge-success' : 'badge-danger'}">${p.active ? 'Active' : 'Inactive'}</span></td>
              <td style="white-space:nowrap">
                <button class="btn btn-sm btn-outline" onclick="App.showProductCard(${p.id})">View</button>
                ${this.can('rentals_manage_items') ? `<button class="btn btn-sm btn-secondary" onclick="App.showRentalItemForm(${p.id})">Edit</button>
                <button class="btn btn-sm btn-outline" onclick="App.showRentalAccessoriesModal(${p.id}, '${p.name.replace(/'/g,"\\'")}')">Accessories</button>` : ''}
                ${this.can('transfers') && p.assigned_branch_id ? `<button class="btn btn-sm btn-outline" onclick="App.showTransferForm({fromBranchId:${p.branch_stock && branchFilter && p.branch_stock.some(s => String(s.branch_id) === branchFilter) ? branchFilter : p.assigned_branch_id},productId:${p.id}})">Transfer</button>` : ''}
              </td>
            </tr>`).join('');
  },

  async showRentalItemForm(id) {
    const [categories, allAccessories, currentAccessories, branches] = await Promise.all([
      this.api('GET', '/categories'),
      this.api('GET', '/products?is_rental=1&is_accessory=1&active=1'),
      id ? this.api('GET', `/products/${id}/accessories`) : Promise.resolve([]),
      this.api('GET', '/branches'),
    ]);
    const p = id ? await this.api('GET', `/products/${id}`) : {};
    // The global stock_qty column can be stale once an item is assigned to a
    // branch (branch_inventory is the real source of truth from then on) —
    // re-fetch branch-scoped so the Stock Qty field shows what's actually there.
    if (id && p.assigned_branch_id) {
      const branchScoped = await this.api('GET', `/products/${id}?branch_id=${p.assigned_branch_id}`);
      p.stock_qty = branchScoped.branch_stock_qty;
      p.min_stock = branchScoped.branch_min_stock;
    }
    const defaultTax = p.tax_rate ?? this.settings?.tax_rate ?? 8.5;
    const classification = p.rental_classification || 'tool';
    const mandatoryIds = currentAccessories.filter(a => a.is_mandatory).map(a => a.accessory_product_id);
    const accessoryOptions = allAccessories.filter(a => a.id !== id);
    // Per-location counts for the accessory panel — an item being turned into
    // an accessory starts with its one branch's stock there.
    const accQtyByBranch = {};
    if (p.branch_stock) p.branch_stock.forEach(s => { accQtyByBranch[s.branch_id] = s.stock_qty; });
    else if (p.assigned_branch_id) accQtyByBranch[p.assigned_branch_id] = p.stock_qty || 0;
    this._rentalFormAccessorySource = currentAccessories; // so save can diff against the assignment ids, not just product ids
    this.showModal(`
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit Rental Item' : 'Add Rental Item'}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>SKU *</label><input id="rf-sku" value="${this.escapeAttr(p.sku)}" placeholder="RENT-001"></div>
            <div class="form-group"><label>Category</label>
              <select id="rf-cat"><option value="">— None —</option>${categories.map(c => `<option value="${c.id}" ${p.category_id==c.id?'selected':''}>${c.name}</option>`).join('')}</select>
            </div>
          </div>
          <div class="form-group"><label>Name *</label><input id="rf-name" value="${this.escapeAttr(p.name)}"></div>
          <div class="form-group"><label>Description</label><input id="rf-desc" value="${this.escapeAttr(p.description)}"></div>
          <div class="form-group"><label>Detailed Description <span style="font-size:11px;color:var(--text-muted);font-weight:400">(shown on the website)</span></label><textarea id="rf-long-desc" rows="5" placeholder="Features, specifications, what's included, care/usage notes…">${this.escapeAttr(p.long_description)}</textarea></div>
          <div class="input-row-3">
            <div class="form-group"><label>Brand</label><input id="rf-brand" value="${this.escapeAttr(p.brand)}"></div>
            <div class="form-group"><label>Model Number</label><input id="rf-model" value="${p.model_number||''}"></div>
            <div class="form-group"><label>Size</label><input id="rf-size" value="${p.size||''}"></div>
          </div>
          <div class="form-group" id="rf-branch-wrap" style="${p.is_accessory ? 'display:none' : ''}"><label>Branch / Location</label>
            <select id="rf-branch">
              <option value="">— Unassigned (global stock only) —</option>
              ${branches.map(b => `<option value="${b.id}" ${p.assigned_branch_id===b.id?'selected':''}>${b.name}</option>`).join('')}
            </select>
            <p style="font-size:11px;color:var(--text-muted);margin-top:2px">Determines which branch's stock this item is drawn from — only staff at (or with multi-branch access to) this branch can see and rent it. Changing this moves the item's stock to the new branch.</p>
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal">
              <input type="checkbox" id="rf-allow-sale" ${p.rental_allow_sale?'checked':''} onchange="App._toggleRentalSaleFields()" style="width:auto"> Also allow selling or quoting this item outright, like a retail item
            </label>
            <p style="font-size:11px;color:var(--text-muted);margin:2px 0 0">Once checked, this item shows up in POS and Quotations at the selling price below, in addition to being rentable. A unit sold this way is removed from stock for good — it never comes back the way a returned rental does.</p>
          </div>
          <div class="form-group" id="rf-sale-price-wrap" style="${p.rental_allow_sale?'':'display:none'}">
            <label>Selling Price *</label>
            <input type="number" id="rf-sale-price" value="${p.price||0}" min="0" step="0.01">
          </div>
          <div class="form-group" style="border:1px solid var(--border);border-radius:6px;padding:12px">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:500;margin:0">
              <input type="checkbox" id="rf-online" ${p.online_available?'checked':''} style="width:auto"> Available for Online Rental Requests
            </label>
            <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Shows this item on the website's Rentals catalog, where customers can request a rental period. Requests still come to sales as a lead — nothing books automatically.</p>
          </div>
          ${id ? `<div class="form-group" style="margin-top:4px"><label>Rental Item Image</label>
        <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
          ${p.image_path ? `<img src="${p.image_path}" class="prod-img-thumb" id="rf-img-preview" alt="">` : `<div class="prod-img-placeholder" id="rf-img-preview" onclick="document.getElementById('rf-img-input').click()">📷</div>`}
          <div>
            <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">Upload Image<input type="file" id="rf-img-input" accept="image/*" style="display:none" onchange="App.uploadRentalItemImage(${id},this)"></label>
            ${p.image_path ? `<button class="btn btn-danger btn-sm" style="margin-left:6px" onclick="App.deleteRentalItemImage(${id})">Remove</button>` : ''}
          </div>
        </div>
      </div>` : ''}
          <div class="input-row-3">
            <div class="form-group" id="rf-stock-wrap" style="${p.is_accessory ? 'display:none' : ''}"><label>Stock Qty *</label><input type="number" id="rf-stock" value="${p.stock_qty??0}" min="0"></div>
            <div class="form-group"><label>Min Stock</label><input type="number" id="rf-minstock" value="${p.min_stock??1}" min="0"></div>
            <div class="form-group"><label>Tax Rate %</label><input type="number" id="rf-tax" value="${defaultTax}" min="0" step="0.1"></div>
          </div>
          <div class="form-group" id="rf-acc-stock" style="border:1px solid var(--border);border-radius:6px;padding:12px;${p.is_accessory ? '' : 'display:none'}">
            <label style="margin-bottom:6px">Stock by Location</label>
            <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px">Accessories can be stocked at several locations — enter the count at each. A checkout only draws from its own location's count. Leave a location at 0 if it doesn't carry this accessory.</p>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px 12px">
              ${branches.map(b => `<label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px;margin:0"><span style="flex:1">${b.name}</span><input type="number" class="rf-acc-branch-qty" data-branch="${b.id}" value="${accQtyByBranch[b.id] || 0}" min="0" step="1" style="width:80px"></label>`).join('')}
            </div>
          </div>
          <div class="form-group"><label>Classification *</label>
            <select id="rf-classification" onchange="App._toggleRentalRateFields()">
              <option value="tool" ${classification==='tool'?'selected':''}>Tool (24-hour day; overdue prorated at daily rate ÷ 24)</option>
              <option value="equipment" ${classification==='equipment'?'selected':''}>Equipment (8-hour work day; hourly rate for partial days)</option>
            </select>
          </div>
          <p id="rf-tier-caption" style="font-size:11px;color:var(--text-muted);margin:-6px 0 8px">${classification==='equipment'
            ? 'Rentals of 28+ days use the monthly rate; 7-27 days mix week/day blocks at their own rates.'
            : 'Tools auto-discount off the daily rate: 7-28 days bills the whole rental at 85% of daily, per day; 28+ days bills the whole rental at 75% of that, per day. Weekly/Monthly Rate are not used for tools.'}</p>
          <div class="input-row-3">
            <div class="form-group"><label>Daily Rate *</label><input type="number" id="rf-rate" value="${p.rental_rate||0}" min="0" step="0.01" oninput="App._suggestRentalTierRates()"></div>
            <div class="form-group">
              <label id="rf-weekly-label">Weekly Rate ${classification==='equipment'?'*':''}</label>
              <input type="number" id="rf-weekly" value="${p.rental_weekly_rate||0}" min="0" step="0.01" style="${classification==='equipment'?'':'display:none'}">
              <div id="rf-weekly-computed" style="${classification==='equipment'?'display:none':''};padding:8px 10px;background:var(--bg-secondary,#f5f5f5);border-radius:6px;font-size:13px;font-weight:600"></div>
            </div>
            <div class="form-group">
              <label id="rf-monthly-label">Monthly Rate ${classification==='equipment'?'*':''}</label>
              <input type="number" id="rf-monthly" value="${p.rental_monthly_rate||0}" min="0" step="0.01" style="${classification==='equipment'?'':'display:none'}">
              <div id="rf-monthly-computed" style="${classification==='equipment'?'display:none':''};padding:8px 10px;background:var(--bg-secondary,#f5f5f5);border-radius:6px;font-size:13px;font-weight:600"></div>
            </div>
          </div>
          <div class="form-group" id="rf-hourly-wrap" style="${classification==='equipment'?'':'display:none'}">
            <label>Hourly Rate * <span style="font-weight:400;color:var(--text-muted)">(equipment only — bills partial days up to 8 hours)</span></label>
            <input type="number" id="rf-hourly" value="${p.rental_hourly_rate||0}" min="0" step="0.01">
          </div>
          <div class="form-group"><label>Replacement Value</label><input type="number" id="rf-replval" value="${p.replacement_value||0}" min="0" step="0.01"></div>
          <div class="input-row">
            <div class="form-group"><label>Status</label>
              <select id="rf-active"><option value="1" ${p.active!==0?'selected':''}>Active</option><option value="0" ${p.active===0?'selected':''}>Inactive</option></select>
            </div>
            <div class="form-group"><label style="display:flex;align-items:center;gap:6px;margin-top:22px">
              <input type="checkbox" id="rf-is-accessory" ${p.is_accessory?'checked':''} onchange="App._toggleRentalAccessoryStock()" style="width:auto"> This is an accessory (can be attached to other rental items)
            </label></div>
          </div>
          <div class="form-group"><label style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="rf-taxable" ${p.taxable!==0?'checked':''} style="width:auto"> Taxable
          </label></div>
          <div class="form-group">
            <label>Mandatory Accessories <span style="font-weight:400;color:var(--text-muted)">(always included with this item, no extra charge)</span></label>
            <div style="max-height:140px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
              ${accessoryOptions.length ? accessoryOptions.map(a => `<label style="display:flex;align-items:center;gap:6px;padding:2px 0">
                <input type="checkbox" class="rf-mandatory-acc" value="${a.id}" ${mandatoryIds.includes(a.id)?'checked':''} style="width:auto"> ${a.name} <span style="color:var(--text-muted);font-size:12px">(${a.sku})</span>
              </label>`).join('') : '<span style="color:var(--text-muted);font-size:12px">No accessory items exist yet — create one and flag it as an accessory first.</span>'}
            </div>
            <p style="font-size:11px;color:var(--text-muted);margin-top:4px">For optional (paid) accessories, use the "Accessories" action on the item's row after saving.</p>
          </div>
        </div>
        <div class="modal-footer">
          ${id ? `<button class="btn btn-danger" onclick="App.deleteRentalItem(${id})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveRentalItem(${id||'null'})">Save</button>
        </div>
      </div>`);
    this._refreshRentalToolTierComputed();
  },

  // Tools ignore the catalog weekly/monthly rate columns entirely — both
  // tiers are always derived from the daily rate (mirrors the tool branch in
  // lib/rentalPricing.js and public/index.html's _calcRentalFeeEstimate).
  // Returns the per-day rate for each tier.
  _toolTierDayRates(daily) {
    const weekTierDayRate = (daily || 0) * 0.85;
    return { weekTierDayRate, monthTierDayRate: weekTierDayRate * 0.75 };
  },

  _toggleRentalSaleFields() {
    const wrap = document.getElementById('rf-sale-price-wrap');
    if (wrap) wrap.style.display = document.getElementById('rf-allow-sale')?.checked ? '' : 'none';
  },

  _toggleRentalRateFields() {
    const cls = document.getElementById('rf-classification')?.value;
    const isEquipment = cls === 'equipment';
    const hourlyWrap = document.getElementById('rf-hourly-wrap');
    if (hourlyWrap) hourlyWrap.style.display = isEquipment ? '' : 'none';
    const caption = document.getElementById('rf-tier-caption');
    if (caption) caption.textContent = isEquipment
      ? 'Rentals of 28+ days use the monthly rate; 7-27 days mix week/day blocks at their own rates.'
      : 'Tools auto-discount off the daily rate: 7-28 days bills the whole rental at 85% of daily, per day; 28+ days bills the whole rental at 75% of that, per day. Weekly/Monthly Rate are not used for tools.';
    ['weekly', 'monthly'].forEach(tier => {
      const label = document.getElementById(`rf-${tier}-label`);
      const input = document.getElementById(`rf-${tier}`);
      const computed = document.getElementById(`rf-${tier}-computed`);
      if (label) label.textContent = `${tier === 'weekly' ? 'Weekly' : 'Monthly'} Rate ${isEquipment ? '*' : ''}`;
      if (input) input.style.display = isEquipment ? '' : 'none';
      if (computed) computed.style.display = isEquipment ? 'none' : '';
    });
    this._refreshRentalToolTierComputed();
  },

  _refreshRentalToolTierComputed() {
    const cls = document.getElementById('rf-classification')?.value;
    if (cls === 'equipment') return;
    const daily = parseFloat(document.getElementById('rf-rate')?.value) || 0;
    const { weekTierDayRate, monthTierDayRate } = this._toolTierDayRates(daily);
    const weeklyEl = document.getElementById('rf-weekly-computed');
    const monthlyEl = document.getElementById('rf-monthly-computed');
    if (weeklyEl) weeklyEl.textContent = `${this.fmt(weekTierDayRate)}/day (7-28 days)`;
    if (monthlyEl) monthlyEl.textContent = `${this.fmt(monthTierDayRate)}/day (28+ days)`;
  },

  // Convenience only — pre-fills week/month rates as a no-discount default
  // (7x / 28x the daily rate) the first time a daily rate is entered, so
  // staff aren't left with a $0 tier by accident if they later switch this
  // item to Equipment. Editable afterward. Tools ignore these catalog
  // fields entirely, so this only matters for equipment.
  _suggestRentalTierRates() {
    const daily = parseFloat(document.getElementById('rf-rate')?.value) || 0;
    const weeklyEl = document.getElementById('rf-weekly');
    const monthlyEl = document.getElementById('rf-monthly');
    if (weeklyEl && !parseFloat(weeklyEl.value)) weeklyEl.value = (daily * 7).toFixed(2);
    if (monthlyEl && !parseFloat(monthlyEl.value)) monthlyEl.value = (daily * 28).toFixed(2);
    this._refreshRentalToolTierComputed();
  },

  async saveRentalItem(id) {
    const sku = document.getElementById('rf-sku').value.trim();
    const name = document.getElementById('rf-name').value.trim();
    if (!sku || !name) { this.alert('SKU and name are required', 'error'); return; }
    const classification = document.getElementById('rf-classification').value;
    const allowSale = document.getElementById('rf-allow-sale').checked;
    const salePrice = parseFloat(document.getElementById('rf-sale-price').value) || 0;
    if (allowSale && salePrice <= 0) { this.alert('Enter a selling price to allow this item to be sold or quoted outright', 'error'); return; }
    const data = {
      sku,
      name,
      description: document.getElementById('rf-desc').value.trim() || null,
      long_description: document.getElementById('rf-long-desc').value.trim() || null,
      brand: document.getElementById('rf-brand').value.trim() || null,
      model_number: document.getElementById('rf-model').value.trim() || null,
      size: document.getElementById('rf-size').value.trim() || null,
      taxable: document.getElementById('rf-taxable').checked ? 1 : 0,
      category_id: document.getElementById('rf-cat').value || null,
      stock_qty: parseInt(document.getElementById('rf-stock').value) || 0,
      min_stock: parseInt(document.getElementById('rf-minstock').value) || 0,
      tax_rate: parseFloat(document.getElementById('rf-tax').value) || 0,
      rental_classification: classification,
      rental_rate: parseFloat(document.getElementById('rf-rate').value) || 0,
      rental_weekly_rate: classification === 'equipment' ? (parseFloat(document.getElementById('rf-weekly').value) || 0) : 0,
      rental_monthly_rate: classification === 'equipment' ? (parseFloat(document.getElementById('rf-monthly').value) || 0) : 0,
      rental_hourly_rate: classification === 'equipment' ? (parseFloat(document.getElementById('rf-hourly').value) || 0) : 0,
      replacement_value: parseFloat(document.getElementById('rf-replval').value) || 0,
      active: parseInt(document.getElementById('rf-active').value),
      is_accessory: document.getElementById('rf-is-accessory').checked ? 1 : 0,
      is_rental: 1,
      rental_allow_sale: allowSale ? 1 : 0,
      price: allowSale ? salePrice : 0,
      online_available: document.getElementById('rf-online').checked ? 1 : 0,
    };
    if (data.is_accessory) {
      data.branch_stock = Array.from(document.querySelectorAll('.rf-acc-branch-qty')).map(el => ({ branch_id: parseInt(el.dataset.branch), stock_qty: parseInt(el.value) || 0 }));
      if (data.branch_stock.some(b => b.stock_qty < 0)) { this.alert('Location counts can\'t be negative', 'error'); return; }
      data.stock_qty = data.branch_stock.reduce((t, b) => t + b.stock_qty, 0);
    } else {
      data.branch_id = document.getElementById('rf-branch')?.value || null;
    }
    const selectedMandatoryIds = Array.from(document.querySelectorAll('.rf-mandatory-acc:checked')).map(cb => parseInt(cb.value));
    try {
      let productId = id;
      if (id) await this.api('PUT', `/products/${id}`, data);
      else { const created = await this.api('POST', '/products', data); productId = created.id; }
      await this._syncRentalMandatoryAccessories(productId, selectedMandatoryIds);
      const filters = this._riFilterState({ search: sku, branchId: data.branch_id });
      this.closeModal();
      this.alert(id ? 'Rental item updated' : 'Rental item created');
      this.renderRentalItems(filters);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Reconciles the item form's mandatory-accessory checkboxes against
  // whatever was already assigned — checked-but-not-assigned gets added
  // (or promoted from optional to mandatory), previously-mandatory-but-now-
  // unchecked gets removed entirely. Optional (paid) assignments made via
  // the separate "Accessories" modal are left untouched either way.
  async _syncRentalMandatoryAccessories(productId, selectedIds) {
    const existing = this._rentalFormAccessorySource || [];
    const existingMandatory = existing.filter(a => a.is_mandatory);
    const toRemove = existingMandatory.filter(a => !selectedIds.includes(a.accessory_product_id));
    const toAdd = selectedIds.filter(pid => !existingMandatory.some(a => a.accessory_product_id === pid));
    for (const a of toRemove) {
      await this.api('DELETE', `/products/${productId}/accessories/${a.id}`);
    }
    for (const pid of toAdd) {
      await this.api('POST', `/products/${productId}/accessories`, { accessory_product_id: pid, is_mandatory: true });
    }
  },

  async deleteRentalItem(id) {
    if (!confirm('Deactivate this rental item?')) return;
    await this.api('DELETE', `/products/${id}`);
    const filters = this._riFilterState();
    this.closeModal();
    this.alert('Rental item deactivated');
    this.renderRentalItems(filters);
  },

  async showRentalAccessoriesModal(productId, productName) {
    const [assigned, allAccessories] = await Promise.all([
      this.api('GET', `/products/${productId}/accessories`),
      this.api('GET', '/products?is_rental=1&is_accessory=1&active=1'),
    ]);
    const assignedIds = assigned.map(a => a.accessory_product_id);
    const available = allAccessories.filter(a => a.id !== productId && !assignedIds.includes(a.id));
    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <span class="modal-title">Accessories — ${productName}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Mandatory accessories are always included at no extra cost. Optional accessories add their own rental cost if selected at checkout.</p>
          <table class="table" style="margin-bottom:14px">
            <thead><tr><th>Accessory</th><th>Rate</th><th>Mandatory</th><th></th></tr></thead>
            <tbody>${assigned.length ? assigned.map(a => `<tr>
              <td>${a.name}</td>
              <td>${this.fmt(a.rental_rate)}/day</td>
              <td>${a.is_mandatory ? '<span class="badge-pill badge-success">Mandatory (free)</span>' : '<span class="badge-pill badge-secondary">Optional</span>'}</td>
              <td><button class="btn btn-sm btn-danger" onclick="App._removeRentalAccessory(${productId}, ${a.id}, '${productName.replace(/'/g,"\\'")}')">Remove</button></td>
            </tr>`).join('') : '<tr><td colspan="4" style="color:var(--text-muted)">No accessories assigned yet.</td></tr>'}</tbody>
          </table>
          <hr style="margin:10px 0">
          <div style="display:flex;gap:8px;align-items:flex-end">
            <div class="form-group" style="flex:2;margin-bottom:0"><label>Add Accessory</label>
              <select id="ra-accessory">
                <option value="">Select accessory item…</option>
                ${available.map(a => `<option value="${a.id}">${a.name} (${a.sku})</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="ra-mandatory" style="width:auto"> Mandatory</label></div>
            <button class="btn btn-primary btn-sm" onclick="App._addRentalAccessory(${productId}, '${productName.replace(/'/g,"\\'")}')">Add</button>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async _addRentalAccessory(productId, productName) {
    const accessory_product_id = document.getElementById('ra-accessory')?.value;
    if (!accessory_product_id) { this.alert('Select an accessory to add', 'error'); return; }
    const is_mandatory = document.getElementById('ra-mandatory')?.checked || false;
    try {
      await this.api('POST', `/products/${productId}/accessories`, { accessory_product_id, is_mandatory });
      this.showRentalAccessoriesModal(productId, productName);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _removeRentalAccessory(productId, assignmentId, productName) {
    await this.api('DELETE', `/products/${productId}/accessories/${assignmentId}`);
    this.showRentalAccessoriesModal(productId, productName);
  },

  // Compact "has this checkpoint been done" indicator for the rentals list —
  // reuses the existing badge-pill/✓-prefix idiom (no dedicated check-icon
  // component exists elsewhere in this file). A muted dash covers both "not
  // reached that stage yet" and legacy agreements issued/returned before
  // this feature existed (their checkpoint columns are simply null).
  _rentalVerificationBadges(a) {
    const muted = '<span style="color:var(--text-muted)">—</span>';
    const issued = a.status !== 'pending' && a.status !== 'awaiting_issue';
    const returned = a.status === 'returned';
    if (!issued) return muted;
    const issueOk = a.issue_security_employee_id && a.issue_security_signature && a.issue_customer_signature;
    const returnOk = a.return_security_employee_id && a.return_security_signature && (!a.pickup_required || a.return_driver_employee_id);
    const parts = [];
    parts.push(issueOk ? `<span class="badge-pill badge-success" style="font-size:10px">✓ Issue</span>` : muted);
    if (returned) parts.push(returnOk ? `<span class="badge-pill badge-success" style="font-size:10px">✓ Return</span>` : muted);
    return parts.join(' ');
  },

  async loadRentalAgreements() {
    const el = document.getElementById('rental-content');
    if (!el) return;
    const view = this.rentalTab === 'all' ? '' : this.rentalTab;
    const agreements = await this.api('GET', `/rentals/agreements${view ? '?view='+view : ''}`);
    if (!document.getElementById('rental-content')) return;
    const sc = { out_for_delivery:'badge-teal', pending:'badge-warning', awaiting_issue:'badge-warning', active:'badge-info', overdue:'badge-danger', paused:'badge-warning', returned:'badge-success', returned_unpaid:'badge-danger', cancelled:'badge-secondary' };
    const none = '<span style="color:var(--text-muted)">None</span>';
    const notAssigned = '<span style="color:var(--text-muted)">Not yet assigned</span>';
    const customerPickupTag = '<span class="badge-pill badge-secondary" style="font-size:11px">Customer Pickup</span>';
    document.getElementById('rental-content').innerHTML = !agreements.length ? '<div class="empty-state"><p>No rental agreements found.</p></div>' : `
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Agreement #</th><th>Customer</th><th>Branch</th><th>Checkout</th><th>Due</th><th>Duration</th><th>Items</th><th>Delivery</th><th>Pickup</th><th>Operator</th><th>Verification</th><th>Status</th><th></th></tr></thead>
        <tbody>${agreements.map(a => `<tr>
          <td class="fw-600">${a.agreement_number}${a.special_project_number ? `<div><span class="badge-pill badge-danger" style="font-size:10px" title="Rental billed on a Special Project">SP ${a.special_project_number}</span></div>` : ''}</td>
          <td>${a.customer_name||'—'}</td>
          <td>${a.branch_name||'—'}</td>
          <td>${(a.status==='pending'||a.status==='awaiting_issue') ? '—' : this.fmtDate(a.checkout_date)}</td>
          <td>${this.fmtDate(a.due_date)}${a.current_pause_started_at ? `<div style="font-size:11px;color:var(--warning)">${this._pauseReasonLabel(a.current_pause_reason)} since ${this.fmtDateTime(a.current_pause_started_at)}${a.current_pause_resume_at ? ` · resumes ${this.fmtDateTime(a.current_pause_resume_at)}` : ''}</div>` : ''}${a.next_scheduled_pause_at ? `<div style="font-size:11px;color:#3b82f6">Stop scheduled ${this.fmtDateTime(a.next_scheduled_pause_at)}</div>` : ''}${a.closed_day_grace ? `<div style="font-size:11px;color:var(--primary)" title="${this.escapeAttr(this._closedDayGraceNote(a))}">Closed day — back by ${this._closedDayReturnBy(a.closed_day_grace, { long: false })}</div>` : ''}</td>
          <td>${(a.status==='pending'||a.status==='awaiting_issue') ? '—' : this.rentalDurationLabel(a.checkout_date, a.due_date, a.returned_at)}</td>
          <td style="max-width:220px;font-size:13px">${a.item_summary||'—'}</td>
          <td>${a.delivery_required ? (a.delivery_driver_name || notAssigned) : (a.customer_pickup ? customerPickupTag : none)}</td>
          <td>${this._pickupDriverCell(a)}</td>
          <td>${a.operator_required ? (a.operator_name || notAssigned) : none}</td>
          <td>${this._rentalVerificationBadges(a)}</td>
          <td><span class="badge-pill ${sc[a.display_status]||'badge-secondary'}">${a.display_status === 'returned_unpaid' ? 'returned – not paid' : a.display_status}</span>${a.display_status === 'returned_unpaid' ? `<div style="font-size:11px;color:var(--danger);font-weight:600">${this.fmt(a.balance_due)} owed</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap">
            ${a.display_status === 'returned_unpaid' && this.can('pos') ? `<button class="btn btn-sm btn-primary" style="margin-right:4px" onclick="App.showRentalBalanceDueModal(${a.id})">Collect</button>` : ''}
            <button class="btn btn-sm btn-outline" onclick="App.viewRentalAgreement(${a.id})">View</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>
      </div>`;
  },

  // ─── Deposits & Credit Notes ────────────────────────────────────────────
  // Standalone page (Sales hub tile, next to Rentals) — previously the
  // "Deposits & Credit Notes" tab inside Rentals, then briefly an Accounts
  // hub tile; moved into Sales so a rentals-only security group (gated on
  // `rentals` alone, same as this tile) never has to be granted the broader
  // Accounts hub just to reach it.
  // Read-only status report over every checked-out rental (active or
  // returned — a deposit only exists once checkout/finalize actually
  // happened), plus the one action this page supports: retroactively
  // issuing a credit note in place of a cash/card refund. Everything else
  // here is computed client-side from figures the checkout/return
  // endpoints (routes/rentals.js) already persisted.

  async renderRentalDeposits() {
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Rental Deposits & Credit Notes</h2>
      </div>
      <div id="rental-deposits-summary" style="margin-bottom:16px"></div>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
        <input type="text" id="rd-search" placeholder="Agreement # or customer…" style="width:220px" oninput="App.filterRentalDeposits()">
        <select id="rd-deposit-status" onchange="App.filterRentalDeposits()" style="width:180px">
          <option value="">All deposit statuses</option>
          ${Object.entries(this._depositStateLabels).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}
        </select>
        <select id="rd-refund-status" onchange="App.filterRentalDeposits()" style="width:200px">
          <option value="">All refunds / credits</option>
          ${Object.entries(this._depositRefundLabels).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}
        </select>
        <span id="rd-count" style="font-size:12px;color:var(--text-muted)"></span>
      </div>
      <div id="rental-deposits-content"></div>`;
    await this.loadRentalDeposits();
  },

  renderDepositSummaryCard(label, amount, count, color) {
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;min-width:160px">
      <div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${color||'inherit'}">${this.fmt(amount)}</div>
      <div style="font-size:11px;color:var(--text-muted)">${count} agreement${count===1?'':'s'}</div>
    </div>`;
  },

  async loadRentalDeposits() {
    const el = document.getElementById('rental-deposits-content');
    if (!el) return;
    // awaiting_issue is included too — the deposit is collected at finalize
    // (PATCH .../checkout), which happens before issue, so a paid-but-not-yet-
    // issued agreement already holds a real deposit that belongs on this list.
    const [awaitingIssue, active, returned, summary] = await Promise.all([
      this.api('GET', '/rentals/agreements?view=awaiting_issue'),
      this.api('GET', '/rentals/agreements?view=active'),
      this.api('GET', '/rentals/agreements?view=returned'),
      this.api('GET', '/rentals/deposits/summary').catch(() => null),
    ]);
    // Held first, then partially applied, fully applied, fully refunded
    // (no-deposit rentals last); newest first within each.
    const order = Object.keys(this._depositStateLabels);
    const agreements = [...awaitingIssue, ...active, ...returned].sort((a, b) =>
      (order.indexOf(this._depositState(a)) - order.indexOf(this._depositState(b))) || (new Date(b.created_at) - new Date(a.created_at)));
    this._rentalDepositsAll = agreements;
    if (!document.getElementById('rental-deposits-content')) return;

    const summaryEl = document.getElementById('rental-deposits-summary');
    if (summaryEl && summary) {
      summaryEl.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
        ${this.renderDepositSummaryCard('Held (Active Rentals)', summary.held.total, summary.held.count)}
        ${this.renderDepositSummaryCard('Refunded — Cash', summary.refunded.cash.total, summary.refunded.cash.count)}
        ${this.renderDepositSummaryCard('Refunded — Bank Transfer', summary.refunded.bank_transfer.total, summary.refunded.bank_transfer.count)}
        ${this.renderDepositSummaryCard('Refunded — Original Card', summary.refunded.original_card.total, summary.refunded.original_card.count)}
        ${this.renderDepositSummaryCard('Store Credit Issued', summary.store_credit.total, summary.store_credit.count)}
        ${this.renderDepositSummaryCard('Applied to Account', summary.applied_to_account.total, summary.applied_to_account.count)}
        ${this.renderDepositSummaryCard('Awaiting Method', summary.pending_method.total, summary.pending_method.count, summary.pending_method.count ? 'var(--warning,#e6a23c)' : null)}
      </div>`;
    } else if (summaryEl) {
      summaryEl.innerHTML = '';
    }

    this.filterRentalDeposits();
  },

  filterRentalDeposits() {
    const el = document.getElementById('rental-deposits-content');
    if (!el) return;
    const all = this._rentalDepositsAll || [];
    const q = (document.getElementById('rd-search')?.value || '').trim().toLowerCase();
    const depositState = document.getElementById('rd-deposit-status')?.value || '';
    const refundState = document.getElementById('rd-refund-status')?.value || '';
    const rows = all.filter(a =>
      (!q || `${a.agreement_number} ${a.customer_name || ''}`.toLowerCase().includes(q))
      && (!depositState || this._depositState(a) === depositState)
      && (!refundState || this._depositRefundState(a) === refundState));
    const count = document.getElementById('rd-count');
    if (count) count.textContent = rows.length === all.length ? `${all.length} agreement${all.length === 1 ? '' : 's'}` : `${rows.length} of ${all.length}`;
    el.innerHTML = !rows.length ? `<div class="empty-state"><p>${all.length ? 'No deposits match these filters.' : 'No rental deposits to show.'}</p></div>` : `
      <table class="table">
        <thead><tr><th>Agreement #</th><th>Customer</th><th>Status</th><th>Deposit</th><th>Deposit Status</th><th>Refund / Credit</th><th></th></tr></thead>
        <tbody>${rows.map(a => this.renderRentalDepositRow(a)).join('')}</tbody>
      </table>`;
  },

  // Deposit status, in the order the list is sorted by.
  _depositStateLabels: { held: 'Held', partial: 'Partially Applied', applied: 'Fully Applied', refunded: 'Fully Refunded', none: 'No Deposit' },

  // deposit_total/deposit_refunded are set once, at return time, by
  // PATCH /rentals/agreements/:id/return — "applied" is whatever portion of
  // the deposit the return's actual fee + damage consumed.
  _depositState(a) {
    if (!a.deposit_total) return 'none';
    if (a.status !== 'returned') return 'held';
    const applied = Math.max(0, a.deposit_total - (a.deposit_refunded || 0));
    if (applied < 0.01) return 'refunded';
    if (applied >= a.deposit_total - 0.01) return 'applied';
    return 'partial';
  },

  _depositRefundLabels: { due: 'Refund Due', refunded: 'Refunded', credit_note: 'Credit Note Issued', account: 'Applied to Account', none: 'Nothing Due' },

  // Same branches as the Refund / Credit cell in renderRentalDepositRow.
  _depositRefundState(a) {
    const refundDue = a.settlement_total < 0 ? -a.settlement_total : 0;
    if (a.credit_note_amount > 0) return 'credit_note';
    if (a.checkout_payment_method === 'credit' && refundDue > 0) return 'account';
    if (['cash', 'bank_transfer', 'original_card'].includes(a.deposit_return_method)) return 'refunded';
    if (refundDue > 0) return 'due';
    return 'none';
  },

  renderRentalDepositRow(a) {
    const sc = { out_for_delivery:'badge-teal', awaiting_issue:'badge-warning', active:'badge-info', overdue:'badge-danger', returned:'badge-success' };
    const state = this._depositState(a);
    const applied = Math.max(0, (a.deposit_total || 0) - (a.deposit_refunded || 0));
    const depositCell = {
      none: '<span style="color:var(--text-muted)">No deposit</span>',
      held: `<span class="badge-pill badge-info">Held</span> ${this.fmt(a.deposit_total)}`,
      refunded: `<span class="badge-pill badge-success">Fully Refunded</span> ${this.fmt(a.deposit_total)}`,
      applied: `<span class="badge-pill badge-danger">Fully Applied</span> ${this.fmt(applied)} of ${this.fmt(a.deposit_total)}`,
      partial: `<span class="badge-pill badge-warning">Partially Applied</span> ${this.fmt(applied)} of ${this.fmt(a.deposit_total)}`,
    }[state];

    // A negative settlement total means the deposit exceeded actual fees
    // (early return, or just low usage/no damage) — a refund is due. Credit
    // accounts already settle this automatically via account_balance at
    // return time; everyone else got a 'refund'-type settlement transaction
    // for the register to pay out, and the method it actually went out
    // through (cash/bank transfer/original card/store credit) is recorded
    // here — see routes/rentals.js's deposit_return_method.
    const methodLabels = { cash: 'Cash Refund', bank_transfer: 'Bank Transfer', original_card: 'Refunded to Original Card' };
    let creditCell;
    const refundDue = a.settlement_total < 0 ? parseFloat((-a.settlement_total).toFixed(2)) : 0;
    if (a.credit_note_amount > 0) {
      creditCell = `<span class="badge-pill badge-teal">Credit Note Issued</span> ${this.fmt(a.credit_note_amount)}
        <div style="margin-top:4px"><button class="btn btn-sm btn-outline" onclick="App.launchRentalSummary(${a.id})">Receipt</button></div>`;
    } else if (a.checkout_payment_method === 'credit' && refundDue > 0) {
      creditCell = `<span class="badge-pill badge-info">Applied to Account</span> ${this.fmt(refundDue)}`;
    } else if (methodLabels[a.deposit_return_method]) {
      creditCell = `<span class="badge-pill badge-success">${methodLabels[a.deposit_return_method]}</span> ${this.fmt(refundDue)}${a.deposit_return_reference ? ` <span style="color:var(--text-muted);font-size:11px">Ref: ${a.deposit_return_reference}</span>` : ''}
        <div style="margin-top:4px"><button class="btn btn-sm btn-outline" onclick="App.launchRentalSummary(${a.id})">Receipt</button></div>`;
    } else if (refundDue > 0) {
      const esc = (s) => (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
      const custName = esc(a.customer_name);
      const reqMethod = esc(a.required_deposit_return_method);
      const reqReason = esc(a.required_deposit_return_reason);
      const policyHint = a.required_deposit_return_method ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Policy: ${methodLabels[a.required_deposit_return_method]}</div>` : '';
      const depositActions = [
        this.can('rentals_deposit_refund') ? `<button class="btn btn-sm btn-outline" onclick="App.recordDepositReturn(${a.id},${refundDue},'${custName}','${reqMethod}','${reqReason}')">Record Refund</button>` : '',
        this.can('rentals_credit_note') ? `<button class="btn btn-sm btn-outline" onclick="App.issueRentalCreditNote(${a.id},${refundDue},'${custName}')">Issue Credit Note</button>` : '',
      ].filter(Boolean).join('');
      creditCell = `<span class="badge-pill badge-warning">Refund Due</span> ${this.fmt(refundDue)}${policyHint}
        ${depositActions ? `<div style="margin-top:4px;display:flex;gap:6px">${depositActions}</div>` : ''}`;
    } else {
      creditCell = '<span style="color:var(--text-muted)">—</span>';
    }

    return `<tr>
      <td class="fw-600">${a.agreement_number}</td>
      <td>${a.customer_name||'—'}</td>
      <td><span class="badge-pill ${sc[a.display_status]||'badge-secondary'}">${a.display_status}</span></td>
      <td>${a.deposit_total ? this.fmt(a.deposit_total) : '—'}</td>
      <td>${depositCell}</td>
      <td>${creditCell}</td>
      <td style="text-align:right"><button class="btn btn-sm btn-outline" onclick="App.viewRentalAgreement(${a.id})">View</button></td>
    </tr>`;
  },

  issueRentalCreditNote(id, maxAmount, customerName) {
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header"><span class="modal-title">Issue Credit Note</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px">Issue a credit note to <strong>${customerName||'this customer'}</strong> instead of a cash/card refund — this adds the amount as store credit on their account.</p>
          <div class="form-group"><label>Amount (max ${this.fmt(maxAmount)})</label>
            <input id="cn-amount" type="number" step="0.01" min="0.01" max="${maxAmount}" value="${maxAmount}">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-success" onclick="App.confirmRentalCreditNote(${id})">Issue Credit Note</button>
        </div>
      </div>`);
  },

  async confirmRentalCreditNote(id) {
    const amount = parseFloat(document.getElementById('cn-amount').value);
    if (!amount || amount <= 0) { this.alert('Enter a valid amount', 'error'); return; }
    try {
      await this.api('POST', `/rentals/agreements/${id}/credit-note`, { amount, employee_id: this.currentUser?.id || null });
      this.closeModal();
      this.loadRentalDeposits();
      this.launchRentalSummary(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Records how a due deposit refund (refundAmount) was actually disbursed —
  // cash, bank transfer, or back to the original card. requiredMethod/
  // requiredReason (from routes/rentals.js's requiredDepositReturnMethod,
  // attached server-side as required_deposit_return_method/_reason) reflect
  // the deposit-refund policy for this agreement's original payment method,
  // amount, and age — pre-selected here but not locked, since real-world
  // exceptions happen; picking a different method just skips the policy note.
  recordDepositReturn(id, refundAmount, customerName, requiredMethod, requiredReason) {
    const methods = [['cash','Cash Refund'], ['bank_transfer','Bank Transfer'], ['original_card','Refund to Original Card']];
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><span class="modal-title">Record Deposit Refund</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px">Refund of <strong>${this.fmt(refundAmount)}</strong> due to <strong>${customerName||'this customer'}</strong>. Record how it was actually given back.</p>
          ${requiredReason ? `<div style="padding:8px 12px;background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;border-radius:4px;font-size:12px;margin-bottom:12px">${requiredReason}</div>` : ''}
          <div class="form-group"><label>Refund Method</label>
            <select id="dr-method">
              ${methods.map(([v,l]) => `<option value="${v}" ${v===requiredMethod?'selected':''}>${l}${v===requiredMethod?' (per policy)':''}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Reference # <span style="color:var(--text-muted);font-weight:400">(transfer ref, approval code, etc. — optional)</span></label>
            <input id="dr-reference" type="text">
          </div>
          <div class="form-group"><label>Notes <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
            <textarea id="dr-notes" rows="2"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-success" onclick="App.confirmDepositReturn(${id})">Record</button>
        </div>
      </div>`);
  },

  async confirmDepositReturn(id) {
    const method = document.getElementById('dr-method').value;
    const reference = document.getElementById('dr-reference').value.trim();
    const notes = document.getElementById('dr-notes').value.trim();
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/deposit-return`, { method, reference, notes, employee_id: this.currentUser?.id || null });
      this.closeModal();
      this.loadRentalDeposits();
      this.launchRentalSummary(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // A comprehensive, single "final rental agreement" document — checkout
  // through return through however the deposit was ultimately settled
  // (balance collected, refunded, or issued as store credit) — replacing the
  // narrower deposit-only receipts that used to print separately. Offered
  // right after issuing a credit note or recording a deposit refund, and
  // reachable any time afterward from the agreement view or the Deposits tab.
  async launchRentalSummary(id) {
    let a;
    try { a = await this.api('GET', `/rentals/agreements/${id}`); }
    catch(e) { this.alert(e.message, 'error'); return; }
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header"><span class="modal-title">${a.agreement_number}</span><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px">A complete summary of this rental — checkout, return, item rates, adjustments, and how the deposit was settled — is ready for the customer.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-secondary" onclick="App.emailRentalSummary(${a.id},'${(a.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email Summary</button>
          <button class="btn btn-primary" onclick="App.printRentalAgreementSummary(${a.id})">🖨️ Print Summary</button>
        </div>
      </div>`);
  },

  emailRentalSummary(agreementId, customerEmail) {
    this.showEmailModal('Email Rental Tax Invoice', customerEmail, async (to, { as_pdf }) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-rental-summary/${agreementId}`, { to, as_pdf });
        this.alert(`Rental tax invoice sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    }, { pdfOption: true });
  },

  // Full-page popup (letter size, same window.open()+document.write()
  // pattern as printReceiptLetter) rather than the narrow 72mm thermal modal
  // style, since @page can't be scripted per-print on the main app window —
  // this needs real column width for the item/rate table. The window is
  // opened synchronously, before the agreement fetch, so it stays inside the
  // click's user-gesture stack and isn't blocked as a popup.
  async printRentalAgreementSummary(id) {
    const win = window.open('', '_blank', 'width=850,height=1000');
    if (!win) { this.alert('Your browser blocked the print popup — allow popups for this site and try again', 'warning'); return; }
    let a;
    try { a = await this.api('GET', `/rentals/agreements/${id}`); }
    catch(e) { win.close(); this.alert(e.message, 'error'); return; }

    const storeName = this.settings.store_name || 'My Store';
    const addressLine = a.branch_address || this.settings.store_address || '';
    const cityLine = a.branch_address ? `${a.branch_city ? ', ' + a.branch_city : ''}${a.branch_state ? ' ' + a.branch_state : ''}${a.branch_zip ? ' ' + a.branch_zip : ''}` : '';
    const phoneLine = a.branch_phone || this.settings.store_phone || '';
    const footer = this._receiptFooterHtml('Thank you for your business!');
    const isReturned = a.status === 'returned';

    const itemRows = (a.items || []).map(i => {
      const tag = i.parent_item_id ? (i.is_mandatory ? ' <span style="color:#16a34a;font-size:10px">(included)</span>' : ' <span style="color:#888;font-size:10px">(accessory)</span>') : '';
      const rateParts = i.is_mandatory ? [] : [`${this.fmt(i.daily_rate)}/day`];
      if (!i.is_mandatory) {
        if (i.weekly_rate) rateParts.push(`${this.fmt(i.weekly_rate)}/wk`);
        if (i.monthly_rate) rateParts.push(`${this.fmt(i.monthly_rate)}/mo`);
      }
      if (i.rate_basis && i.rate_basis.length) rateParts.splice(0, rateParts.length, this._rateBasisLabel(i.rate_basis));
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e8e8;white-space:nowrap;color:#555">${i.sku || ''}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e8e8">${i.product_name}${tag}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e8e8;text-align:center">${i.quantity}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e8e8;text-align:center;font-size:11px;color:#555">${i.is_mandatory ? 'No charge' : rateParts.join(' · ')}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e8e8;text-align:right">${this.fmt(i.rental_fee)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e8e8;text-align:right">${i.quantity_returned > 0 ? this.fmt(i.final_rental_fee) : '—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e8e8;text-align:right">${i.damage_fee > 0 ? this.fmt(i.damage_fee) : '—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e8e8;text-align:center;font-size:11px;color:#555">${i.condition_out||'—'} → ${i.condition_in||'—'}</td>
      </tr>`;
    }).join('');

    const serviceFeesTotal = (a.delivery_required ? a.delivery_cost||0 : 0) + (a.pickup_cost_charged != null ? a.pickup_cost_charged : (a.pickup_required ? a.pickup_cost||0 : 0)) + (a.operator_required ? a.operator_fee||0 : 0);
    const rentalFeeSubtotal = parseFloat(((a.checkout_subtotal||0) - a.deposit_total - serviceFeesTotal).toFixed(2));
    const checkoutRows = a.checkout_transaction_id ? [
      ['Rental Fee Subtotal', this.fmt(rentalFeeSubtotal)],
      serviceFeesTotal > 0 ? ['Delivery / Pickup / Operator Fees', this.fmt(serviceFeesTotal)] : null,
      ['Tax', this.fmt(a.checkout_tax_amount)],
      ['Deposit Collected', this.fmt(a.deposit_total)],
      a.checkout_discount_amount > 0 ? ['Discount', `-${this.fmt(a.checkout_discount_amount)}`] : null,
      ['Total Charged at Checkout', this.fmt(a.checkout_total)],
      ['Payment Method', (a.checkout_payment_method||'').replace(/_/g, ' ').toUpperCase()],
    ].filter(Boolean) : [];

    const durationAdjLabel = a.duration_adjustment_total > 0 ? 'Additional Rental Time' : a.duration_adjustment_total < 0 ? 'Rental Fee Credit (returned early)' : 'Duration Adjustment';
    const settlementRows = isReturned ? [
      a.damage_fee_total ? ['Damage Fees', this.fmt(a.damage_fee_total)] : null,
      a.duration_adjustment_total ? [durationAdjLabel, this.fmt(a.duration_adjustment_total)] : null,
      a.tax_adjustment_total ? ['Tax Adjustment', this.fmt(a.tax_adjustment_total)] : null,
      a.service_adjustment_total ? [a.service_adjustment_total > 0 ? 'Pickup Fee (added after checkout)' : 'Pickup Fee Credit (pickup cancelled or reduced)', this.fmt(a.service_adjustment_total)] : null,
      ['Less: Deposit Applied', `-${this.fmt(a.deposit_total)}`],
    ].filter(Boolean) : [];
    const balanceLabel = a.balance_due > 0.004 ? 'BALANCE DUE' : a.balance_due < -0.004 ? 'REFUND DUE' : 'SETTLED IN FULL';
    const balanceDisplay = this.fmt(Math.abs(a.balance_due));

    let dispositionLine = null;
    if (isReturned && a.balance_due > 0.004) {
      if (a.settlement_transaction_id) {
        dispositionLine = `Collected ${this.fmt(a.balance_due)} via ${(a.settlement_payment_method||'').replace(/_/g, ' ').toUpperCase()} on ${this.fmtDateTime(a.settlement_created_at)}${a.settlement_amount_tendered > a.balance_due ? ` — Tendered ${this.fmt(a.settlement_amount_tendered)}, Change ${this.fmt(a.settlement_change_amount)}` : ''}.`;
      } else {
        dispositionLine = 'Balance due has not yet been collected — see POS Hold Recall.';
      }
    } else if (isReturned && a.balance_due < -0.004) {
      if (a.credit_note_amount > 0) {
        dispositionLine = `Issued as store credit on the customer's account: ${this.fmt(a.credit_note_amount)} on ${this.fmtDateTime(a.credit_note_issued_at)}${a.credit_note_issued_by_name ? ` by ${a.credit_note_issued_by_name}` : ''}.`;
      } else if (a.checkout_payment_method === 'credit') {
        dispositionLine = `Applied automatically to the customer's account balance: ${this.fmt(-a.settlement_total)}.`;
      } else if (['cash','bank_transfer','original_card'].includes(a.deposit_return_method)) {
        const methodLabels = { cash: 'Cash', bank_transfer: 'Bank Transfer', original_card: 'Refund to Original Card' };
        dispositionLine = `Refunded via ${methodLabels[a.deposit_return_method]} on ${this.fmtDateTime(a.deposit_return_recorded_at)}${a.deposit_return_reference ? ` — Ref: ${a.deposit_return_reference}` : ''}${a.deposit_return_recorded_by_name ? ` (recorded by ${a.deposit_return_recorded_by_name})` : ''}.`;
      } else {
        dispositionLine = 'Refund due — not yet disbursed.';
      }
    }

    const issueSignatures = [];
    if (a.issue_customer_signature) issueSignatures.push(['Customer', a.customer_name, a.issue_customer_signature, a.issued_at]);
    if (a.issue_security_signature) issueSignatures.push(['Security (Issue)', a.issue_security_employee_name, a.issue_security_signature, a.issue_security_confirmed_at]);
    if (a.return_security_signature) issueSignatures.push(['Security (Return)', a.return_security_employee_name, a.return_security_signature, a.return_security_confirmed_at]);
    if (a.return_driver_signature) issueSignatures.push(['Driver (Return)', a.return_driver_employee_name, a.return_driver_signature, a.return_driver_confirmed_at]);

    win.document.write(`<!DOCTYPE html><html><head><title>Rental Tax Invoice – ${a.agreement_number}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:0;padding:48px;color:#111}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
      .store h1{font-size:20px;margin:0 0 2px}
      .store div{font-size:12px;color:#555}
      .doc-title{font-size:20px;font-weight:700;text-align:right;color:#333}
      .meta{display:flex;flex-wrap:wrap;gap:24px;margin-bottom:16px;font-size:12px}
      .meta div{line-height:1.6}
      .meta label{font-weight:bold;text-transform:uppercase;font-size:10px;color:#555;display:block}
      h2{font-size:12px;text-transform:uppercase;color:#555;margin:20px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px}
      table{width:100%;border-collapse:collapse}
      th{background:#f0f0f0;text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;color:#555}
      .totals{width:340px;margin-left:auto;font-size:13px}
      .totals tr td{padding:3px 0;border:none}
      .totals .total-row td{border-top:2px solid #111;font-size:15px;font-weight:700;padding-top:6px}
      .disposition{margin-top:8px;padding:8px 12px;background:#f5f5f5;border-left:3px solid #555;font-size:12px;border-radius:4px}
      ${this._billToPrintCss}
      .footer{margin-top:32px;font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:10px;text-align:center}
      @page { size: letter; margin: 0.75in; }
      @media print{body{padding:0}}
    </style></head><body>
    <div style="text-align:center;font-weight:700;font-size:20px;margin-bottom:16px">${storeName}</div>
    <div class="header">
      <div class="store">
        ${this._printLogoTag(50)}
        ${a.branch_name ? `<h1>${a.branch_name}</h1>` : ''}
        ${addressLine ? `<div>${addressLine}${cityLine}</div>` : ''}
        ${phoneLine ? `<div>${phoneLine}</div>` : ''}
      </div>
      <div class="doc-title">RENTAL TAX INVOICE</div>
    </div>
    ${this._billToPrintHtml(a, [['Agreement #', a.agreement_number], ['P.O. #', this._poValueHtml(a.customer_po_number)]])}
    <div class="meta">
      <div><label>Checked Out</label>${a.checkout_datetime ? this.fmtDateTime(a.checkout_datetime) : '—'}</div>
      <div><label>Due Date</label>${this.fmtDate(a.due_date)}</div>
      <div><label>Returned</label>${a.returned_at ? this.fmtDateTime(a.returned_at) : 'Not yet returned'}</div>
      <div><label>Duration</label>${a.checkout_datetime ? this.rentalDurationLabel(a.checkout_date, a.due_date, a.returned_at) : '—'}</div>
    </div>
    <h2>Items Rented</h2>
    <table>
      <thead><tr><th>SKU</th><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:center">Rate</th><th style="text-align:right">Original Fee</th><th style="text-align:right">Final Fee</th><th style="text-align:right">Damage Fee</th><th style="text-align:center">Condition Out → In</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    ${checkoutRows.length ? `<h2>Checkout Charges</h2>
    <table class="totals">${checkoutRows.map(([l,v]) => `<tr><td>${l}</td><td style="text-align:right">${v}</td></tr>`).join('')}</table>` : ''}
    ${settlementRows.length ? `<h2>Return Settlement</h2>
    <table class="totals">
      ${settlementRows.map(([l,v]) => `<tr><td>${l}</td><td style="text-align:right">${v}</td></tr>`).join('')}
      <tr class="total-row"><td>${balanceLabel}</td><td style="text-align:right">${balanceDisplay}</td></tr>
    </table>
    ${dispositionLine ? `<div class="disposition">${dispositionLine}</div>` : ''}` : ''}
    ${issueSignatures.length ? `<h2>Signatures</h2>
    <div style="display:flex;gap:16px;margin-top:8px">
      ${issueSignatures.map(([label, name, src, signedAt]) => `<div style="flex:1;text-align:center">
        <img src="${src}" style="max-height:50px;max-width:100%;border-bottom:1px solid #333;padding-bottom:4px" />
        <div style="font-size:10px;color:#555;margin-top:4px">${label}${name ? ` — ${name}` : ''}</div>
        ${signedAt ? `<div style="font-size:9px;color:#888">${this.fmtDateTime(signedAt)}</div>` : ''}
      </div>`).join('')}
    </div>` : ''}
    ${this._invoiceSignatureLinesHtml(!!a.issue_customer_signature)}
    <div class="footer">${footer}</div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
    win.document.close();
  },

  async viewRentalAgreement(id) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    const sc = { out_for_delivery:'badge-teal', pending:'badge-warning', awaiting_issue:'badge-warning', active:'badge-info', overdue:'badge-danger', returned:'badge-success', cancelled:'badge-secondary' };
    const notYetIssued = a.status === 'pending' || a.status === 'awaiting_issue';
    // A missed-pickup pause should be resolved through "Record Customer
    // Decision" (documents what the customer said, and lets staff pick a
    // real new pickup date) rather than the plain Resume button, which just
    // silently extends by however long it's been paused with no record of
    // why.
    const openMissedPickupPause = a.is_paused ? a.pauses?.find(p => !p.ended_at && p.reason === 'missed_pickup') : null;
    const openReplacementPause = a.is_paused ? a.pauses?.find(p => !p.ended_at && p.reason === 'replacement') : null;
    this.showModal(`
      <div class="modal" style="max-width:1100px">
        <div class="modal-header">
          <span class="modal-title">${a.agreement_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            <span class="badge-pill ${sc[a.display_status]||'badge-secondary'}" style="font-size:13px">${a.display_status.toUpperCase()}</span>
            ${a.checkout_payment_method === 'credit' ? `<span class="badge-pill badge-info" style="font-size:13px">Billed to Account</span>` : ''}
            ${a.special_project_number ? `<span class="badge-pill badge-danger" style="font-size:13px" title="Paid with the Special Project invoice">Special Project <a href="#" style="color:inherit" onclick="event.preventDefault();App.closeModal();App.viewQuote(${a.quotation_id})">${a.special_project_number}</a></span>` : ''}
            ${a.credit_note_amount > 0 ? `<span class="badge-pill badge-teal" style="font-size:13px">Credit Note: ${this.fmt(a.credit_note_amount)}</span>` : ''}
            ${a.checkout_transaction_number?`<span style="font-size:13px">Checkout: ${a.checkout_transaction_number}</span>`:''}
            ${a.settlement_transaction_number?`<span style="font-size:13px">Settlement: ${a.settlement_transaction_number}</span>`:''}
          </div>
          <div class="input-row" style="margin-bottom:10px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Customer</label><div>${a.customer_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Branch</label><div>${a.branch_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Checkout Date</label><div>${notYetIssued ? `<span style="color:var(--text-muted)">${a.status==='pending'?'Awaiting checkout':'Awaiting issue'}</span>` : this.fmtDate(a.checkout_date)}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Due Date</label><div>${this.fmtDate(a.due_date)}${a.closed_day_grace ? `<div style="font-size:11px;color:var(--primary)">${this._closedDayGraceNote(a)}</div>` : ''}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Duration</label><div>${notYetIssued ? `<span style="color:var(--text-muted)">${a.status==='pending'?'TBD at checkout':'Clock starts on issue'}</span>` : this.rentalDurationLabel(a.checkout_date, a.due_date, a.returned_at)}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Rate</label><div>${this._ratePlanLabel(a.rate_plan)}</div></div>
          </div>
          ${a.status==='pending' ? `<div style="padding:8px 12px;background:rgba(245,158,11,0.08);border-left:3px solid #d97706;border-radius:4px;font-size:12px;color:#d97706;margin-bottom:12px">Held — no payment collected yet. Fees and deposit are calculated when a cashier processes payment, based on the rental period starting at that moment.</div>` : ''}
          ${a.status==='awaiting_issue' ? `<div style="padding:8px 12px;background:rgba(245,158,11,0.08);border-left:3px solid #d97706;border-radius:4px;font-size:12px;color:#d97706;margin-bottom:12px">Paid — waiting to be issued (collected or delivered). The rental clock starts once it's issued.</div>` : ''}
          ${(a.delivery_required || a.pickup_required || a.operator_required || a.customer_pickup) ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Additional Services</strong>
            ${a.customer_pickup ? `<div>Customer Pickup — item collected by the customer at the counter</div>` : ''}
            ${a.delivery_required ? `<div>Delivery — ${this.fmt(a.delivery_cost)}${a.delivery_driver_name ? ` — ${a.delivery_driver_name}` : ' — driver not yet assigned'}${a.delivery_address ? `<div style="color:var(--text-muted)">📍 ${this.escapeAttr(a.delivery_address)}</div>` : ''}</div>` : ''}
            ${a.operator_required ? `<div>Operator — ${this.fmt(a.operator_fee)}${a.operator_name ? ` — ${a.operator_name}` : ' — not yet assigned'}</div>` : ''}
            ${a.pickup_required ? `<div>Pickup — ${this.fmt(a.pickup_cost)}${a.pickup_driver_name ? ` — ${a.pickup_driver_name}` : ' — driver not yet assigned'}${this._rentalPickupAddress(a) ? `<div style="color:var(--text-muted)">📍 ${this.escapeAttr(this._rentalPickupAddress(a))}</div>` : ''}
              ${a.pickup_confirmed_at ? ` <span class="badge-pill badge-success" style="font-size:10px">✓ Confirmed ${this.fmtDateTime(a.pickup_confirmed_at)}</span>${a.pickup_customer_name ? ` — signed by ${a.pickup_customer_name}` : ''}${this._sigButton(a.pickup_customer_signature, 'View Customer Signature')}`
              : (a.status==='active' && this.can('rentals_issue') ? ` <button class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.closeModal();App.showAssignPickupDriverModal(${a.id})">${a.pickup_driver_name?'Reassign':'Assign'} Driver</button>` : '')}
              ${!a.pickup_confirmed_at && ['pending','awaiting_issue','active'].includes(a.status) && this.can('rentals_issue') ? ` <button class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.closeModal();App.showChangePickupModal(${a.id})">Change Pickup</button>` : ''}</div>` : ''}
            ${a.service_adjustment_total ? `<div style="margin-top:4px;color:var(--warning,#d97706)">Pickup fee ${a.service_adjustment_total > 0 ? `+${this.fmt(a.service_adjustment_total)} owed` : `${this.fmt(-a.service_adjustment_total)} credit`} — ${a.status === 'returned' ? 'included in the return settlement' : 'settled when the item is returned'}</div>` : ''}
          </div>` : ''}
          ${!a.pickup_required && ['pending','awaiting_issue','active'].includes(a.status) && this.can('rentals_issue') ? `<div style="margin:-6px 0 12px"><button class="btn btn-sm btn-outline" onclick="App.closeModal();App.showChangePickupModal(${a.id})">+ Add Pickup</button>${a.service_adjustment_total ? ` <span style="font-size:12px;color:var(--warning,#d97706)">Pickup cancelled — ${this.fmt(-a.service_adjustment_total)} credit settled at return</span>` : ''}</div>` : ''}
          ${a.pickup_changes?.length ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Pickup Changes</strong>
            ${a.pickup_changes.map(c => `<div style="margin-top:4px"><strong>${c.action === 'add' ? 'Pickup added' : c.action === 'cancel' ? 'Pickup cancelled' : 'Pickup changed'}</strong> — ${this.fmtDateTime(c.created_at)}${c.employee_name ? ` by ${c.employee_name}` : ''}
              <div style="color:var(--text-muted)">${[
                c.action !== 'cancel' && c.old_address !== c.new_address && c.new_address ? `Address: ${this.escapeAttr(c.new_address)}` : '',
                c.action !== 'cancel' && c.old_cost != c.new_cost ? `Fee: ${c.old_cost != null ? this.fmt(c.old_cost) + ' → ' : ''}${this.fmt(c.new_cost)}` : '',
                c.fee_adjustment ? `${c.fee_adjustment > 0 ? '+' : ''}${this.fmt(c.fee_adjustment)} at return` : '',
                c.reason ? this.escapeAttr(c.reason) : '',
              ].filter(Boolean).join(' · ')}</div></div>`).join('')}
          </div>` : ''}
          ${a.customer_po_number ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Customer PO</strong>
            <div>PO # ${a.customer_po_number}${a.customer_po_attachment_path ? ` <a href="/api/rentals/agreements/${a.id}/po-attachment/download" target="_blank" class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px;margin-left:6px">Download PO</a>` : ''}</div>
          </div>` : ''}
          ${a.is_paused ? (openMissedPickupPause ? `<div style="padding:10px 12px;background:rgba(220,38,38,0.08);border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#991b1b;margin-bottom:12px">
                <strong>⏸ Missed Pickup — Auto-Paused</strong>
                <div style="margin-top:4px">The scheduled pickup wasn't completed by the due date/time. Contact the customer to arrange next steps.</div>
                ${a.customer_phone ? `<div style="margin-top:6px">Phone: <a href="tel:${a.customer_phone}" style="color:#991b1b;font-weight:600">${a.customer_phone}</a></div>` : ''}
                ${openMissedPickupPause.contact_notes ? `<div style="margin-top:6px;white-space:pre-wrap;color:#7c2d12"><strong>Contact log:</strong><br>${openMissedPickupPause.contact_notes}</div>` : ''}
                <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn btn-sm btn-secondary" onclick="App.showMissedPickupContactModal(${a.id},'email')">✉️ Email Customer</button>
                  <button class="btn btn-sm btn-secondary" onclick="App.showMissedPickupContactModal(${a.id},'phone')">📞 Log Call</button>
                  <button class="btn btn-sm btn-primary" onclick="App.showMissedPickupConfirmModal(${a.id})">Record Customer Decision</button>
                </div>
              </div>` : `<div style="padding:8px 12px;background:rgba(217,119,6,0.1);border-left:3px solid #d97706;border-radius:4px;font-size:12px;color:#d97706;margin-bottom:12px">${(() => { const op = a.pauses?.find(p=>!p.ended_at); return `Paused — ${this._pauseReasonLabel(op?.reason).toLowerCase()} since ${op ? this.fmtDateTime(op.started_at) : '—'}.${op?.scheduled_resume_at ? ` <strong>Resumes automatically ${this.fmtDateTime(op.scheduled_resume_at)}.</strong>` : ''}`; })()}${openReplacementPause ? ' Use Replace Item to swap the faulty unit, then resume.' : ''} Resume it before processing a return.
                <button class="btn btn-sm btn-outline" style="margin-left:6px;padding:1px 8px;font-size:11px" onclick="App.closeModal();App.showScheduleResumeModal(${a.id})">${a.pauses?.find(p=>!p.ended_at)?.scheduled_resume_at ? 'Change Resume Time' : 'Set Resume Time'}</button></div>`) : ''}
          ${a.pause_series?.length ? `<div style="padding:8px 12px;background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;border-radius:4px;font-size:12px;margin-bottom:12px">
            <strong>Recurring stops</strong>
            ${a.pause_series.map(sr => { const next = (a.scheduled_pauses || []).find(sp => sp.series_id === sr.id && sp.status === 'scheduled'); return `<div style="margin-top:4px;display:flex;justify-content:space-between;gap:8px;align-items:center">
              <span><strong>${this._pauseReasonLabel(sr.reason)}</strong> — ${sr.description}${next ? ` · next ${this.fmtDateTime(next.starts_at)}` : ''} · ${sr.stops_taken} taken so far${sr.notes ? ` <span style="color:var(--text-muted)">· ${this.escapeAttr(sr.notes)}</span>` : ''}</span>
              <button class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.cancelPauseSeries(${a.id},${sr.id})">Stop Repeating</button>
            </div>`; }).join('')}
          </div>` : ''}
          ${a.scheduled_pauses?.some(sp => sp.status === 'scheduled' && !sp.series_id) ? `<div style="padding:8px 12px;background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;border-radius:4px;font-size:12px;margin-bottom:12px">
            <strong>Scheduled stops</strong>
            ${a.scheduled_pauses.filter(sp => sp.status === 'scheduled' && !sp.series_id).map(sp => `<div style="margin-top:4px;display:flex;justify-content:space-between;gap:8px;align-items:center">
              <span><strong>${this._pauseReasonLabel(sp.reason)}</strong> — ${this.fmtDateTime(sp.starts_at)} → ${sp.ends_at ? this.fmtDateTime(sp.ends_at) : 'until resumed'}${sp.notes ? ` <span style="color:var(--text-muted)">· ${this.escapeAttr(sp.notes)}</span>` : ''}</span>
              <button class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.cancelScheduledPause(${a.id},${sp.id})">Cancel</button>
            </div>`).join('')}
          </div>` : ''}
          ${a.pauses?.length ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Pause History</strong>
            ${a.pauses.map(p => `<div style="margin-top:4px">
              <strong>${this._pauseReasonLabel(p.reason)}</strong> — ${this.fmtDateTime(p.started_at)} → ${p.ended_at ? this.fmtDateTime(p.ended_at) : `<span style="color:var(--warning)">Ongoing${p.scheduled_resume_at ? ` (resumes ${this.fmtDateTime(p.scheduled_resume_at)})` : ''}</span>`}
              ${p.notes ? `<div style="color:var(--text-muted)">${p.notes}</div>` : ''}
              ${p.customer_confirmation ? `<div style="color:var(--text-muted)">Customer confirmed: <strong style="text-transform:capitalize">${p.customer_confirmation}</strong>${p.confirmed_by_name ? ` (logged by ${p.confirmed_by_name})` : ''}</div>` : ''}
              <div style="color:var(--text-muted);font-size:11px">Paused by ${p.paused_by_name || (p.reason==='missed_pickup' ? 'System (auto-pause)' : '—')}, authorized by ${p.authorized_by_name||'—'}${p.ended_at ? `, resumed by ${p.resumed_by_name || (p.scheduled_resume_at ? 'schedule' : '—')}` : ''}${p.due_date_after ? ` — due date extended to ${this.fmtDate(p.due_date_after)}` : ''}</div>
            </div>`).join('')}
          </div>` : ''}
          ${this._dispatchScheduleHtml(a)}
          ${a.maintenance?.length ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Maintenance</strong>
            ${a.maintenance.map(m => `<div style="margin-top:4px;display:flex;justify-content:space-between;gap:8px;align-items:center">
              <span><strong>${m.product_name}</strong> × ${m.quantity} — <span style="text-transform:capitalize">${m.reason}</span> since ${this.fmtDateTime(m.opened_at)} · ${m.status === 'open' ? '<span class="badge-pill badge-warning" style="font-size:10px">In maintenance</span>' : `<span class="badge-pill badge-success" style="font-size:10px">Completed</span>`} · ${m.log_count} log entr${m.log_count === 1 ? 'y' : 'ies'}${m.total_cost > 0 ? ` · ${this.fmt(m.total_cost)}` : ''}</span>
              <button class="btn btn-sm btn-outline" onclick="App.closeModal();App.showRentalMaintenance(${m.id})">Log</button>
            </div>`).join('')}
          </div>` : ''}
          ${a.replacements?.length ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Item Replacements</strong>
            ${a.replacements.map(r => `<div style="margin-top:4px">
              ${this.fmtDateTime(r.created_at)} — <strong>${r.quantity} x ${r.old_product_name}</strong>${r.old_sku ? ` (${r.old_sku})` : ''} → <strong>${r.new_product_name}</strong>${r.new_sku ? ` (${r.new_sku})` : ''}
              ${r.notes ? `<div style="color:var(--text-muted)">${r.notes}</div>` : ''}
              <div style="color:var(--text-muted);font-size:11px">Replaced by ${r.replaced_by_name || '—'} — the original is held out of service; time before the swap is billed at its rates, time after at the replacement's</div>
            </div>`).join('')}
          </div>` : ''}
          ${!notYetIssued ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Chain of Custody</strong>
            <div>Issue — ${a.issue_security_employee_name ? `Security: ${a.issue_security_employee_name} (${this.fmtDateTime(a.issue_security_confirmed_at)})` : '<span style="color:var(--text-muted)">no security record (issued before this check existed)</span>'}
              ${this._sigButton(a.issue_security_signature, 'View Guard Signature')}${this._sigButton(a.issue_customer_signature, 'View Customer Signature')}</div>
            ${a.status==='returned' ? `<div>Return — ${a.return_security_employee_name ? `Security: ${a.return_security_employee_name} (${this.fmtDateTime(a.return_security_confirmed_at)})` : '<span style="color:var(--text-muted)">no security record</span>'}${a.return_driver_employee_name ? `, Collected by: ${a.return_driver_employee_name}` : ''}
              ${this._sigButton(a.return_security_signature, 'View Guard Signature')}</div>` : ''}
          </div>` : ''}
          <table class="table" style="margin-bottom:12px">
            <thead><tr><th>Product</th><th>Rate</th><th>Class</th><th>Qty</th><th>Returned</th><th>Est. Fee</th><th>Actual Fee</th><th>Deposit</th><th>Condition</th></tr></thead>
            <tbody>${a.items.map(i=>{
              const tag = i.parent_item_id ? (i.is_mandatory ? ' <span class="badge-pill badge-success" style="font-size:10px">included</span>' : ' <span class="badge-pill badge-secondary" style="font-size:10px">accessory</span>') : '';
              const rateParts = i.is_mandatory ? null : [`${this.fmt(i.daily_rate)}/day`];
              if (rateParts) {
                if (i.weekly_rate) rateParts.push(`${this.fmt(i.weekly_rate)}/wk`);
                if (i.monthly_rate) rateParts.push(`${this.fmt(i.monthly_rate)}/mo`);
                if (i.rate_basis && i.rate_basis.length) rateParts.splice(0, rateParts.length, this._rateBasisLabel(i.rate_basis));
              }
              return `<tr>
              <td>${i.product_name}${tag}</td>
              <td style="font-size:12px;color:var(--text-muted)">${i.is_mandatory ? 'Included, no charge' : rateParts.join(' · ')}</td>
              <td>${i.rental_classification==='equipment'?'Equipment':'Tool'}</td>
              <td>${i.quantity}</td>
              <td>${i.quantity_returned}</td>
              <td>${a.status==='pending' ? '—' : this.fmt(i.rental_fee)}</td>
              <td>${i.quantity_returned>0 ? this.fmt(i.final_rental_fee) : '—'}</td>
              <td>${a.status==='pending' ? '—' : this.fmt(i.deposit_amount)}</td>
              <td style="color:var(--text-muted);font-size:12px">${i.condition_out||'—'} → ${i.condition_in||'—'}${i.damage_notes?`<br><span class="color-danger">${i.damage_notes}</span>`:''}</td>
            </tr>`;}).join('')}</tbody>
          </table>
          <div style="display:flex;justify-content:space-between;font-size:13px">
            <span>Deposit Total: ${this.fmt(a.deposit_total)}</span>
            <span>Duration Adjustment: ${this.fmt(a.duration_adjustment_total)}</span>
            <span>Damage Fee: ${this.fmt(a.damage_fee_total)}</span>
            <span>Deposit Refunded: ${this.fmt(a.deposit_refunded)}</span>
          </div>
        </div>
        <div class="modal-footer footer-wrap">
          ${a.status==='pending' && this.can('pos') && !a.quotation_id ? `<button class="btn btn-primary" onclick="App.closeModal();App.showFinalizeRentalModal(${a.id})">Process Payment</button>` : ''}
          ${a.status==='awaiting_issue' && this.can('rentals_issue') ? `<button class="btn btn-primary" onclick="App.closeModal();App.showIssueRentalModal(${a.id})">Issue Rental</button>` : ''}
          ${a.checkout_transaction_id ? `<button class="btn btn-secondary" onclick="App.printRentalInvoice(${a.id})">🖨️ Rental Agreement</button>
          <button class="btn btn-secondary" onclick="App.emailRentalInvoice(${a.id},'${(a.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email Agreement</button>
          <button class="btn btn-secondary" onclick="App.closeModal();App.launchRentalSummary(${a.id})">📋 Full Summary</button>` : ''}
          ${a.status==='active' ? `<button class="btn btn-secondary" onclick="App.printRentalDeliveryNote(${a.id})">🖨️ Delivery Note</button>` : ''}
          ${a.status==='active' && !a.is_paused ? `<button class="btn btn-secondary" onclick="App.closeModal();App.showPauseRentalModal(${a.id})">⏸ Pause / Schedule Stop</button>` : ''}
          ${a.status==='active' && a.is_paused ? `<button class="btn btn-secondary" onclick="App.closeModal();App.showPauseRentalModal(${a.id}, { scheduleOnly: true })">🗓 Schedule Stop</button>` : ''}
          ${openReplacementPause && a.status==='active' ? `<button class="btn btn-secondary" onclick="App.closeModal();App.showReplaceRentalItemModal(${a.id})">🔁 Replace Item</button>` : ''}
          ${a.status==='active' && a.is_paused && !openMissedPickupPause ? `<button class="btn btn-primary" onclick="App.resumeRentalAgreement(${a.id})">▶ Resume Rental</button>` : ''}
          ${a.status==='active' && !a.is_paused && this.can('rentals_returns') ? `<button class="btn btn-primary" onclick="App.closeModal();App.showRentalReturnModal(${a.id})">Process Return</button>` : ''}
          ${(a.status==='active'||a.status==='pending'||a.status==='awaiting_issue') && !a.items.some(i=>i.quantity_returned>0) && this.can('rentals_returns') ? `<button class="btn btn-danger" onclick="App.cancelRentalAgreement(${a.id})">${a.status==='pending'?'Cancel Hold':'Cancel Agreement'}</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  // Pausing is the exceptional, billing-affecting action — it requires a
  // manager PIN entered on the spot — visible to anyone who can see
  // the agreement, the PIN is what actually gates it.
  _pauseReasonLabels: {
    replacement: 'Replacement', repair: 'Repair', servicing: 'Servicing', maintenance: 'Maintenance', relocation: 'Relocation',
    operator: 'Operator stop', negotiated: 'Negotiated stop', missed_pickup: 'Missed pickup', other: 'Other',
  },
  _pauseReasonLabel(r) { return this._pauseReasonLabels[r] || (r ? r.replace(/_/g, ' ') : 'Pause'); },

  // datetime-local value (store/browser local time) for a Date
  _dtLocal(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; },

  // Operator and negotiated stops can be booked ahead (start later) and/or
  // set to resume on their own; any pause can be given a resume time.
  _onPauseReasonChange() {
    const reason = document.getElementById('pr-reason').value;
    document.getElementById('pr-maint-items').style.display = ['repair','servicing','maintenance'].includes(reason) ? '' : 'none';
    const schedulable = ['operator', 'negotiated'].includes(reason);
    const startWrap = document.getElementById('pr-start-wrap');
    if (startWrap) startWrap.style.display = schedulable ? '' : 'none';
    const repeatWrap = document.getElementById('pr-repeat-wrap');
    if (repeatWrap) repeatWrap.style.display = schedulable ? '' : 'none';
    if (!schedulable) { const now = document.getElementById('pr-start-now'); if (now) now.checked = true; const rp = document.getElementById('pr-repeat'); if (rp) rp.value = ''; }
    this._onPauseTimingChange();
  },

  _onPauseTimingChange() {
    const repeat = document.getElementById('pr-repeat')?.value || '';
    const series = document.getElementById('pr-series');
    if (series) series.style.display = repeat ? '' : 'none';
    const single = document.getElementById('pr-single-timing');
    if (single) single.style.display = repeat ? 'none' : '';
    document.querySelectorAll('#pr-s-day, #pr-e-day').forEach(el => { el.style.display = repeat === 'weekly' ? '' : 'none'; });
    const daysWrap = document.getElementById('pr-days-wrap');
    if (daysWrap) daysWrap.style.display = repeat === 'weekdays' ? '' : 'none';
    const submit = document.getElementById('pr-submit');
    if (submit) submit.textContent = repeat ? 'Set Recurring Stop' : document.getElementById('pr-start-later')?.checked && document.getElementById('pr-start-wrap')?.style.display !== 'none' ? 'Schedule Stop' : 'Pause Rental';
    const startAt = document.getElementById('pr-start-at');
    if (startAt) startAt.style.display = document.getElementById('pr-start-later')?.checked ? '' : 'none';
    const resumeAt = document.getElementById('pr-resume-at');
    if (resumeAt) resumeAt.style.display = document.getElementById('pr-resume-later')?.checked ? '' : 'none';
  },

  async showPauseRentalModal(id, { scheduleOnly = false } = {}) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    const outstanding = (a.items || []).filter(i => i.quantity > i.quantity_returned);
    const soon = new Date(Date.now() + 86400000); soon.setMinutes(0, 0, 0);
    const later = new Date(soon.getTime() + 86400000);
    this.showModal(`
      <div class="modal" style="max-width:580px">
        <div class="modal-header">
          <span class="modal-title">Pause Rental — Manager Override</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Pausing stops the billing clock and pushes the due date out by however long it lasts — the customer isn't charged for downtime that isn't their fault.</p>
          <div class="form-group"><label>Reason</label>
            <select id="pr-reason" onchange="App._onPauseReasonChange()">
              ${(scheduleOnly ? ['operator', 'negotiated'] : ['replacement', 'repair', 'servicing', 'maintenance', 'relocation', 'operator', 'negotiated']).map(r => `<option value="${r}">${this._pauseReasonLabel(r)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" id="pr-repeat-wrap" style="${scheduleOnly ? '' : 'display:none'}"><label>Repeat</label>
            <select id="pr-repeat" onchange="App._onPauseTimingChange()">
              <option value="">Doesn't repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="weekdays">Specific days</option>
            </select>
          </div>
          <div id="pr-series" style="display:none">
            <div class="form-group" id="pr-days-wrap" style="display:none"><label>Stops start on</label>
              <div style="display:flex;gap:10px;flex-wrap:wrap">
                ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => `<label style="display:flex;align-items:center;gap:4px;font-weight:normal;text-transform:none;font-size:13px;cursor:pointer"><input type="checkbox" class="pr-day" value="${i}" ${i >= 1 && i <= 5 ? 'checked' : ''} style="width:15px;height:15px;margin:0"> ${d}</label>`).join('')}
              </div>
            </div>
            <div class="input-row">
              <div class="form-group" style="min-width:0"><label>Stop</label><div style="display:flex;gap:6px">
                <select id="pr-s-day" style="width:112px;flex-shrink:0">${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => `<option value="${i}" ${i === 6 ? 'selected' : ''}>${d}</option>`).join('')}</select>
                <input type="time" id="pr-s-time" value="17:00" style="flex:1;min-width:0"></div></div>
              <div class="form-group" style="min-width:0"><label>Resume</label><div style="display:flex;gap:6px">
                <select id="pr-e-day" style="width:112px;flex-shrink:0">${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${d}</option>`).join('')}</select>
                <input type="time" id="pr-e-time" value="07:00" style="flex:1;min-width:0"></div></div>
            </div>
            <div class="input-row">
              <div class="form-group"><label>Starting</label><input type="date" id="pr-from" value="${new Date().toISOString().slice(0, 10)}"></div>
              <div class="form-group"><label>Until <span style="color:var(--text-muted);font-weight:400;font-size:11px">(blank = until returned)</span></label><input type="date" id="pr-until"></div>
            </div>
            <div id="pr-series-hint" style="font-size:11px;color:var(--text-muted);margin:-4px 0 10px">Times are store time. If the resume time is earlier than the stop time, it resumes the next day.</div>
          </div>
          <div class="input-row" id="pr-single-timing" style="align-items:flex-start">
            <div class="form-group" id="pr-start-wrap" style="${scheduleOnly ? '' : 'display:none'}"><label>Stop</label>
              ${scheduleOnly ? '' : `<label style="display:flex;align-items:center;gap:6px;font-weight:normal;text-transform:none;font-size:13px;margin:2px 0"><input type="radio" name="pr-start" id="pr-start-now" checked onchange="App._onPauseTimingChange()" style="width:auto;margin:0"> Now</label>`}
              <label style="display:flex;align-items:center;gap:6px;font-weight:normal;text-transform:none;font-size:13px;margin:2px 0"><input type="radio" name="pr-start" id="pr-start-later" ${scheduleOnly ? 'checked' : ''} onchange="App._onPauseTimingChange()" style="width:auto;margin:0"> At</label>
              <input type="datetime-local" id="pr-start-at" value="${this._dtLocal(soon)}" style="${scheduleOnly ? '' : 'display:none'}">
            </div>
            <div class="form-group"><label>Resume</label>
              <label style="display:flex;align-items:center;gap:6px;font-weight:normal;text-transform:none;font-size:13px;margin:2px 0"><input type="radio" name="pr-resume" id="pr-resume-manual" ${scheduleOnly ? '' : 'checked'} onchange="App._onPauseTimingChange()" style="width:auto;margin:0"> Manually</label>
              <label style="display:flex;align-items:center;gap:6px;font-weight:normal;text-transform:none;font-size:13px;margin:2px 0"><input type="radio" name="pr-resume" id="pr-resume-later" ${scheduleOnly ? 'checked' : ''} onchange="App._onPauseTimingChange()" style="width:auto;margin:0"> Automatically at</label>
              <input type="datetime-local" id="pr-resume-at" value="${this._dtLocal(later)}" style="${scheduleOnly ? '' : 'display:none'}">
            </div>
          </div>
          <div class="form-group" id="pr-maint-items" style="display:none"><label>Item(s) going in</label>
            ${outstanding.map(i => `<label style="display:flex;align-items:center;gap:8px;font-weight:normal;text-transform:none;font-size:13px;margin:4px 0;cursor:pointer">
              <input type="checkbox" class="pr-maint-item" value="${i.id}" ${outstanding.length === 1 || !i.parent_item_id ? 'checked' : ''} style="width:16px;height:16px;margin:0">
              ${i.parent_item_id ? '↳ ' : ''}${i.product_name} × ${i.quantity - i.quantity_returned}</label>`).join('')}
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Each gets a record in Rentals → In Maintenance, where the work is logged. The notes below are its first entry.</div>
          </div>
          <div class="form-group"><label>Notes</label><textarea id="pr-notes" rows="3" placeholder="What's happening and why"></textarea></div>
          <div class="form-group"><label>Override PIN</label>
            <input type="password" id="pr-pin" maxlength="8" placeholder="Manager PIN" style="letter-spacing:4px;font-size:18px;text-align:center" onkeydown="if(event.key==='Enter')App.submitPauseRental(${id})">
          </div>
          <div id="pr-err" style="color:var(--danger);font-size:13px;min-height:16px;text-align:center"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="pr-submit" onclick="App.submitPauseRental(${id})">${scheduleOnly ? 'Schedule Stop' : 'Pause Rental'}</button>
        </div>
      </div>`);
    setTimeout(() => document.getElementById('pr-notes')?.focus(), 50);
  },

  async submitPauseRental(id) {
    const reason = document.getElementById('pr-reason').value;
    const notes = document.getElementById('pr-notes').value.trim();
    const pin = document.getElementById('pr-pin').value;
    const errEl = document.getElementById('pr-err');
    if (!notes) { if (errEl) errEl.textContent = 'Notes are required.'; return; }
    if (!pin) { if (errEl) errEl.textContent = 'PIN is required.'; return; }
    try {
      const maintenance_item_ids = Array.from(document.querySelectorAll('.pr-maint-item:checked')).map(cb => parseInt(cb.value));
      if (['repair', 'servicing', 'maintenance'].includes(reason) && !maintenance_item_ids.length) { if (errEl) errEl.textContent = 'Choose the item(s) going in.'; return; }
      const repeat = ['operator', 'negotiated'].includes(reason) ? (document.getElementById('pr-repeat')?.value || '') : '';
      if (repeat) {
        const series = await this.api('POST', `/rentals/agreements/${id}/pause-series`, {
          reason, notes, override_pin: pin, employee_id: this.currentUser.id, frequency: repeat,
          start_day: document.getElementById('pr-s-day').value, start_time: document.getElementById('pr-s-time').value,
          end_day: document.getElementById('pr-e-day').value, end_time: document.getElementById('pr-e-time').value,
          from_date: document.getElementById('pr-from').value, until_date: document.getElementById('pr-until').value || null,
          days: Array.from(document.querySelectorAll('.pr-day:checked')).map(cb => parseInt(cb.value)),
        });
        this.closeModal();
        const booked = (series.occurrences || []).filter(o => o.status !== 'cancelled').length;
        this.alert(`Recurring ${this._pauseReasonLabel(reason).toLowerCase()} set — ${series.description}. ${booked} stop${booked === 1 ? '' : 's'} booked for the next two weeks.`);
        this.renderRentals();
        return;
      }
      const startLater = document.getElementById('pr-start-later')?.checked && ['operator', 'negotiated'].includes(reason);
      const resumeLater = document.getElementById('pr-resume-later')?.checked;
      const starts_at = startLater ? new Date(document.getElementById('pr-start-at').value).toISOString() : null;
      const resume_at = resumeLater ? new Date(document.getElementById('pr-resume-at').value).toISOString() : null;
      const result = await this.api('POST', `/rentals/agreements/${id}/pause`, { reason, notes, override_pin: pin, employee_id: this.currentUser.id, maintenance_item_ids, starts_at, resume_at });
      this.closeModal();
      this.alert(result.scheduled ? `${this._pauseReasonLabel(reason)} scheduled` : `Rental paused${resume_at ? ' — it will resume automatically' : ''}`);
      this.renderRentals();
    } catch(e) {
      if (errEl) errEl.textContent = e.message;
      document.getElementById('pr-pin').value = '';
      document.getElementById('pr-pin').focus();
    }
  },

  async showScheduleResumeModal(id) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    const op = a.pauses?.find(p => !p.ended_at);
    if (!op) { this.alert('This rental is not paused', 'warning'); return; }
    const def = op.scheduled_resume_at ? new Date(op.scheduled_resume_at) : (() => { const d = new Date(Date.now() + 86400000); d.setMinutes(0, 0, 0); return d; })();
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header"><span class="modal-title">Resume Time — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)">Paused for ${this._pauseReasonLabel(op.reason).toLowerCase()} since ${this.fmtDateTime(op.started_at)}. The rental resumes itself at this time — the due date is extended by the time it was paused, as with a manual resume.</p>
          <div class="form-group"><label>Resume at</label><input type="datetime-local" id="sr-at" value="${this._dtLocal(def)}"></div>
        </div>
        <div class="modal-footer">
          ${op.scheduled_resume_at ? `<button class="btn btn-outline" onclick="App.saveScheduledResume(${id}, true)">Clear (resume manually)</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveScheduledResume(${id})">Save</button>
        </div>
      </div>`);
  },

  async saveScheduledResume(id, clear = false) {
    try {
      const v = document.getElementById('sr-at')?.value;
      await this.api('PATCH', `/rentals/agreements/${id}/schedule-resume`, { resume_at: clear || !v ? null : new Date(v).toISOString() });
      this.closeModal();
      this.alert(clear ? 'Resume time cleared' : 'Resume time set');
      this.viewRentalAgreement(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async cancelPauseSeries(agreementId, seriesId) {
    if (!confirm('Stop this recurring stop? Booked stops that haven\'t started are cancelled; one already under way carries on until it resumes.')) return;
    try {
      await this.api('DELETE', `/rentals/agreements/${agreementId}/pause-series/${seriesId}`);
      this.alert('Recurring stop ended');
      this.closeModal();
      this.viewRentalAgreement(agreementId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async cancelScheduledPause(agreementId, scheduledId) {
    if (!confirm('Cancel this scheduled stop?')) return;
    try {
      await this.api('DELETE', `/rentals/agreements/${agreementId}/scheduled-pauses/${scheduledId}`);
      this.alert('Scheduled stop cancelled');
      this.closeModal();
      this.viewRentalAgreement(agreementId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // No PIN — ending downtime isn't the exceptional action, starting it was.
  async resumeRentalAgreement(id) {
    if (!confirm('Resume this rental? The due date will be extended by however long it was paused.')) return;
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/resume`, { employee_id: this.currentUser.id });
      this.alert('Rental resumed — due date extended');
      this.viewRentalAgreement(id);
      this.renderRentals();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Swap a faulty unit while the rental is paused for replacement (POST
  // /rentals/agreements/:id/replace-item). Only rental items available at
  // the agreement's branch are offered — the same product is fine (a
  // like-for-like unit). The original is held out of service server-side.
  async showReplaceRentalItemModal(id) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    const lines = a.items.filter(i => i.quantity_returned < i.quantity);
    if (!lines.length) { this.alert('No items are still out on this agreement', 'warning'); return; }
    const products = await this.api('GET', `/products?is_rental=1&active=1${a.branch_id ? '&branch_id=' + a.branch_id : ''}`);
    this._replaceProducts = products
      .map(p => ({ ...p, available: (p.stock_qty || 0) - (p.rental_outstanding_qty || 0) }))
      .filter(p => p.available > 0)
      .sort((x, y) => x.name.localeCompare(y.name));
    if (!this._replaceProducts.length) { this.alert(`No rental items are available${a.branch_name ? ' at ' + a.branch_name : ''} to use as a replacement`, 'warning'); return; }
    const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header">
          <span class="modal-title">Replace Item — ${a.agreement_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">The original unit is held out of service until it's returned to service (Rentals &gt; Out of Service). Time before the swap is billed at the original item's rates, time after at the replacement's — settled when the rental is returned.</p>
          <div class="form-group"><label>Item being replaced</label>
            <select id="rpl-item" onchange="App._replaceItemChanged()">
              ${lines.map(i => `<option value="${i.id}" data-out="${i.quantity - i.quantity_returned}" data-product="${i.product_id || ''}">${esc(i.product_name)}${i.sku ? ` (${esc(i.sku)})` : ''} — ${i.quantity - i.quantity_returned} out</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Quantity to replace</label><input type="number" id="rpl-qty" min="1" value="1"></div>
          <div class="form-group"><label>Replacement item</label>
            <select id="rpl-product" onchange="App._replaceItemChanged()">
              ${this._replaceProducts.map(p => `<option value="${p.id}">${esc(p.name)}${p.sku ? ` (${esc(p.sku)})` : ''} — ${p.available} available</option>`).join('')}
            </select>
            <div id="rpl-rates" style="font-size:12px;color:var(--text-muted);margin-top:4px"></div>
          </div>
          <div class="form-group"><label>Condition Out (replacement)</label><input id="rpl-cond" placeholder="e.g. Good condition"></div>
          <div class="form-group"><label>Notes</label><textarea id="rpl-notes" rows="3" placeholder="What was wrong with the original unit"></textarea></div>
          <div id="rpl-err" style="color:var(--danger);font-size:13px;min-height:16px;text-align:center"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal();App.viewRentalAgreement(${a.id})">Cancel</button>
          <button class="btn btn-primary" id="rpl-submit" onclick="App.submitReplaceRentalItem(${a.id})">Replace Item</button>
        </div>
      </div>`);
    // Default the replacement to the same product when a spare is on hand —
    // the common like-for-like swap.
    const sel = document.getElementById('rpl-item');
    const same = this._replaceProducts.find(p => String(p.id) === sel.selectedOptions[0].dataset.product);
    if (same) document.getElementById('rpl-product').value = same.id;
    this._replaceItemChanged();
  },

  _replaceItemChanged() {
    const itemOpt = document.getElementById('rpl-item')?.selectedOptions[0];
    const qtyEl = document.getElementById('rpl-qty');
    if (itemOpt && qtyEl) {
      qtyEl.max = itemOpt.dataset.out;
      if (parseInt(qtyEl.value) > parseInt(itemOpt.dataset.out)) qtyEl.value = itemOpt.dataset.out;
    }
    const p = this._replaceProducts?.find(x => String(x.id) === document.getElementById('rpl-product')?.value);
    const ratesEl = document.getElementById('rpl-rates');
    if (p && ratesEl) {
      const parts = [`${this.fmt(p.rental_rate)}/day`];
      if (p.rental_weekly_rate) parts.push(`${this.fmt(p.rental_weekly_rate)}/wk`);
      if (p.rental_monthly_rate) parts.push(`${this.fmt(p.rental_monthly_rate)}/mo`);
      ratesEl.textContent = `Billed at ${parts.join(' · ')} from the swap on`;
    }
  },

  async submitReplaceRentalItem(id) {
    const errEl = document.getElementById('rpl-err');
    const item_id = parseInt(document.getElementById('rpl-item').value);
    const quantity = parseInt(document.getElementById('rpl-qty').value);
    const product_id = parseInt(document.getElementById('rpl-product').value);
    const notes = document.getElementById('rpl-notes').value.trim();
    const condition_out = document.getElementById('rpl-cond').value.trim();
    if (!notes) { errEl.textContent = 'Notes are required.'; return; }
    if (!quantity || quantity < 1) { errEl.textContent = 'Enter a quantity.'; return; }
    const btn = document.getElementById('rpl-submit');
    btn.disabled = true;
    try {
      await this.api('POST', `/rentals/agreements/${id}/replace-item`, { item_id, quantity, product_id, notes, condition_out: condition_out || null, employee_id: this.currentUser.id });
      this.closeModal();
      this.alert('Item replaced — the original is held out of service');
      this.viewRentalAgreement(id);
    } catch(e) {
      errEl.textContent = e.message;
      btn.disabled = false;
    }
  },

  // Contacting the customer after an auto-pause (see database.js's
  // rental_agreement_pauses migration comment / routes/rentals.js's
  // checkMissedPickups). 'email' actually sends a message via
  // /email/send-missed-pickup-contact, then logs it; 'phone' has nothing to
  // send — the button just opens straight to logging the call's outcome.
  async showMissedPickupContactModal(id, method) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    const isEmail = method === 'email';
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <span class="modal-title">${isEmail ? '✉️ Email Customer' : '📞 Log Call'} — ${a.agreement_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          ${isEmail ? `<div class="form-group"><label>To</label><input id="mpc-to" type="email" value="${a.customer_email||''}" placeholder="customer@example.com"></div>
          <div class="form-group"><label>Message</label><textarea id="mpc-message" rows="5">We tried to pick up the item(s) on rental agreement ${a.agreement_number} as scheduled but weren't able to reach you. Please contact us so we can arrange the pickup.</textarea></div>`
          : `<p style="font-size:13px;color:var(--text-muted);margin-bottom:10px">${a.customer_phone ? `Call ${a.customer_name||'the customer'} at <a href="tel:${a.customer_phone}">${a.customer_phone}</a>, then log the outcome below.` : 'Log the outcome of your call below.'}</p>
          <div class="form-group"><label>What happened</label><textarea id="mpc-notes" rows="4" placeholder="e.g. Left voicemail, or: Spoke with customer, arranging pickup for tomorrow"></textarea></div>`}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitMissedPickupContact(${id},'${method}')">${isEmail ? 'Send & Log' : 'Log Call'}</button>
        </div>
      </div>`);
  },

  async submitMissedPickupContact(id, method) {
    const isEmail = method === 'email';
    const notes = isEmail ? document.getElementById('mpc-message').value.trim() : document.getElementById('mpc-notes').value.trim();
    if (!notes) { this.alert(isEmail ? 'Enter a message' : 'Enter what happened on the call', 'error'); return; }
    try {
      if (isEmail) {
        const to = document.getElementById('mpc-to').value.trim();
        if (!to || !to.includes('@')) { this.alert('Please enter a valid email address', 'error'); return; }
        await this.api('POST', `/email/send-missed-pickup-contact/${id}`, { to, message: notes });
      }
      await this.api('PATCH', `/rentals/agreements/${id}/missed-pickup-contact`, { contact_method: method, notes, employee_id: this.currentUser.id });
      this.closeModal();
      this.alert(isEmail ? 'Email sent and logged' : 'Call logged');
      this.viewRentalAgreement(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showMissedPickupConfirmModal(id) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <span class="modal-title">Record Customer Decision — ${a.agreement_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">After reaching the customer, record what they decided. This documents the customer's confirmation on the agreement's pause history — it doesn't change any charges automatically.</p>
          <div class="form-group"><label>Customer's Decision</label>
            <select id="mpd-decision" onchange="App._toggleMissedPickupDueDate()">
              <option value="continue">Continue the rental</option>
              <option value="stop">Stop the rental</option>
            </select>
          </div>
          <div class="form-group" id="mpd-due-date-group"><label>New Pickup Date</label><input type="date" id="mpd-due-date" value="${tomorrow}" min="${new Date().toISOString().slice(0,10)}"></div>
          <div class="form-group"><label>Notes</label><textarea id="mpd-notes" rows="3" placeholder="What was discussed/agreed"></textarea></div>
          <div class="form-group"><label style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="mpd-send-email" ${a.customer_email ? 'checked' : 'disabled'} style="width:auto"> Send confirmation email to customer${a.customer_email ? '' : ' (no email on file)'}
          </label></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.confirmMissedPickupDecision(${id})">Save Decision</button>
        </div>
      </div>`);
  },

  _toggleMissedPickupDueDate() {
    const decision = document.getElementById('mpd-decision')?.value;
    const group = document.getElementById('mpd-due-date-group');
    if (group) group.style.display = decision === 'continue' ? 'block' : 'none';
  },

  async confirmMissedPickupDecision(id) {
    const decision = document.getElementById('mpd-decision').value;
    const notes = document.getElementById('mpd-notes').value.trim() || null;
    const sendEmail = document.getElementById('mpd-send-email').checked;
    const new_due_date = decision === 'continue' ? document.getElementById('mpd-due-date').value : null;
    if (decision === 'continue' && !new_due_date) { this.alert('Enter a new pickup date', 'error'); return; }
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/missed-pickup-confirm`, { decision, new_due_date, notes, employee_id: this.currentUser.id });
      if (sendEmail) {
        try {
          const a = await this.api('GET', `/rentals/agreements/${id}`);
          if (a.customer_email) await this.api('POST', `/email/send-missed-pickup-confirmation/${id}`, { to: a.customer_email });
        } catch(e) {}
      }
      this.closeModal();
      this.alert(decision === 'continue' ? `Rental resumed — new pickup date ${this.fmtDate(new_due_date)}` : 'Rental stop confirmed — process the return once the item is back');
      this.viewRentalAgreement(id);
      this.renderRentals();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Shared "Pickup" column cell for the dispatch/deliveries and rentals list
  // tables — shows who's assigned (with an inline reassign/assign action,
  // gated on rentals_issue same as Issue) and whether they've already
  // confirmed collection in the field (see confirm-pickup).
  _pickupDriverCell(a) {
    if (!a.pickup_required) return '<span style="color:var(--text-muted)">None</span>';
    const canAssign = a.status === 'active' && !a.pickup_confirmed_at && this.can('rentals_issue');
    if (a.pickup_confirmed_at) {
      return `${a.pickup_driver_name||'—'} <span class="badge-pill badge-success" style="font-size:10px">✓ Confirmed</span>`;
    }
    const nameOrNone = a.pickup_driver_name || '<span style="color:var(--text-muted)">Not yet assigned</span>';
    const btn = canAssign ? ` <button class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:10px" onclick="App.showAssignPickupDriverModal(${a.id})">${a.pickup_driver_name ? 'Reassign' : 'Assign'}</button>` : '';
    return `${nameOrNone}${btn}`;
  },

  // A rental agreement can now carry up to three separate signatures
  // (customer + guard at Issue, guard at Return) — this renders the "View
  // ___ Signature" button for whichever one is present, or nothing at all
  // if that checkpoint predates this feature (null column).
  _sigButton(url, label) {
    if (!url) return '';
    return ` <button type="button" class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.showRentalSignature('${url.replace(/'/g,"\\'")}','${label.replace(/'/g,"\\'")}')">${label}</button>`;
  },

  // Shows a signature inline instead of a plain <a target="_blank"> link —
  // some locked-down/kiosk browsers (the kind a security-guard tablet at a
  // gate is likely to run) navigate the SAME tab when a target="_blank"
  // link can't open a real new one, which reloads the whole SPA; init()
  // always shows the login screen unconditionally on load (it doesn't
  // restore an existing session), so that reload looks exactly like
  // getting signed out even though the cookie was still valid. A same-page
  // modal can't trigger that at all.
  showRentalSignature(url, title = 'Signature') {
    this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">${title}</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="text-align:center">
          <img src="${url}" alt="${title}" style="max-width:100%;border:1px solid var(--border);border-radius:6px;background:#fff">
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  // Due date/time shown to the customer isn't a separately-stored field —
  // it's the same synthesis the checkout/return fee math already uses
  // (due_date's calendar date, at the same time-of-day the rental was
  // actually issued), so what's printed here always matches what the
  // system will actually bill against.
  _rentalDueDateTime(a) {
    if (!a.due_date) return null;
    const timePart = a.checkout_datetime ? new Date(a.checkout_datetime).toISOString().slice(11, 19) : '00:00:00';
    return new Date(`${a.due_date}T${timePart}.000Z`);
  },

  async printRentalDeliveryNote(id) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    const storeName = this.settings.store_name || 'My Store';
    const addressLine = a.branch_address || this.settings.store_address || '';
    const cityLine = a.branch_address ? `${a.branch_city ? ', ' + a.branch_city : ''}${a.branch_state ? ' ' + a.branch_state : ''}${a.branch_zip ? ' ' + a.branch_zip : ''}` : '';
    const phoneLine = a.branch_phone || this.settings.store_phone || '';

    const custAddressParts = [a.customer_address, [a.customer_city, a.customer_state, a.customer_zip].filter(Boolean).join(' ')].filter(Boolean);
    const deliverTo = a.delivery_address || custAddressParts.join(', ') || '—';

    const dueDT = this._rentalDueDateTime(a);
    const dueLabel = dueDT ? this.fmtDateTime(dueDT) : this.fmtDate(a.due_date);

    const itemRows = a.items.filter(i => !i.parent_item_id).map(i => {
      const accs = a.items.filter(x => x.parent_item_id === i.id);
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8">${i.product_name}${accs.length ? `<div style="font-size:11px;color:#777">+ ${accs.map(x=>x.product_name).join(', ')}</div>` : ''}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;text-align:center">${i.quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8">${dueLabel}</td>
      </tr>`;
    }).join('');

    const win = window.open('', '_blank', 'width=850,height=1000');
    win.document.write(`<!DOCTYPE html><html><head><title>Delivery Note – ${a.agreement_number}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:0;padding:48px;color:#111}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
      .store h1{font-size:20px;margin:0 0 2px}
      .store div{font-size:12px;color:#555}
      .doc-title{font-size:22px;font-weight:700;text-align:right;color:#333}
      .meta{display:flex;gap:32px;margin-bottom:20px;font-size:12px;flex-wrap:wrap}
      .meta div{line-height:1.6}
      .meta label{font-weight:bold;text-transform:uppercase;font-size:10px;color:#555;display:block}
      table{width:100%;border-collapse:collapse;margin-top:8px}
      th{background:#f0f0f0;text-align:left;padding:8px;font-size:11px;text-transform:uppercase;color:#555}
      .footer{margin-top:32px;font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:10px;text-align:center}
      @page { size: letter; margin: 0.75in; }
      @media print{body{padding:0}}
    </style></head><body>
    <div style="text-align:center;font-weight:700;font-size:20px;margin-bottom:16px">${storeName}</div>
    <div class="header">
      <div class="store">
        ${this._printLogoTag(50)}
        ${a.branch_name ? `<h1>${a.branch_name}</h1>` : ''}
        ${addressLine ? `<div>${addressLine}${cityLine}</div>` : ''}
        ${phoneLine ? `<div>${phoneLine}</div>` : ''}
      </div>
      <div class="doc-title">DELIVERY NOTE</div>
    </div>
    <div class="meta">
      <div><label>Rental Agreement #</label>${a.agreement_number}</div>
      <div><label>Date Issued</label>${this.fmtDateTime(a.checkout_datetime || a.issued_at)}</div>
      <div><label>Customer</label>${a.customer_name||'—'}</div>
      ${a.customer_phone ? `<div><label>Phone</label>${a.customer_phone}</div>` : ''}
    </div>
    <div class="meta" style="margin-top:-8px">
      <div style="flex:1"><label>Deliver To</label>${deliverTo}${a.customer_phone ? ` — ${a.customer_phone}` : ''}</div>
    </div>
    <table>
      <thead><tr><th>Item</th><th style="text-align:center">Qty</th><th>Due Back</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    ${a.notes ? `<div style="margin-top:16px;font-size:12px"><strong>Notes:</strong> ${a.notes}</div>` : ''}
    <div style="display:flex;justify-content:space-between;margin-top:70px;gap:24px">
      <div style="flex:1;text-align:center"><div style="border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555">Received By (Print Name)</div></div>
      <div style="flex:1;text-align:center"><div style="border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555">Signature</div></div>
      <div style="flex:1;text-align:center"><div style="border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555">Date</div></div>
    </div>
    <div class="footer">${this._receiptFooterHtml('Thank you!')}</div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
    win.document.close();
  },

  // Reprints the letter-size RENTAL AGREEMENT (checkout invoice) for an already-checked-out
  // agreement — same document (and same printReceiptLetter renderer) shown
  // right after Process Payment completes, just re-fetched from the
  // checkout transaction on demand rather than held in session state.
  async printRentalInvoice(id) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    if (!a.checkout_transaction_id) { this.alert('This rental has not been checked out yet', 'warning'); return; }
    const tx = await this.api('GET', `/transactions/${a.checkout_transaction_id}`);
    this._lastReceiptTx = tx;
    this._lastReceiptChange = 0;
    this._lastReceiptCash = null;
    this._lastReceiptSplitForeign = null;
    this.printReceiptLetter();
  },

  cancelRentalAgreement(id) {
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <span class="modal-title">Cancel Rental Agreement</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Any checkout charge already collected will be voided.</p>
          <div class="form-group"><label>Reason (optional)</label>
            <input type="text" id="cancel-rental-reason" placeholder="e.g. Customer no longer needs the item...">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Back</button>
          <button class="btn btn-danger" onclick="App._confirmCancelRentalAgreement(${id})">Cancel Agreement</button>
        </div>
      </div>`);
  },

  async _confirmCancelRentalAgreement(id) {
    const reason = document.getElementById('cancel-rental-reason')?.value.trim() || null;
    try {
      const agreement = await this.api('PATCH', `/rentals/agreements/${id}/cancel`, { reason, employee_id: this.currentUser?.id || null });
      this.closeModal();
      this.alert('Rental agreement cancelled');
      this.renderRentals();
      this.showCancellationReceipt(agreement);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showCancellationReceipt(agreement) {
    const items = (agreement.items || []).filter(i => !i.parent_item_id);
    const storeName = this.settings.store_name || 'My Store';
    const wasBilled = agreement.checkout_transaction_number != null;
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <span class="modal-title">Rental Cancellation Receipt</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="receipt">
            <div class="receipt-store" style="text-align:center;font-weight:700;font-size:15px;margin-bottom:6px">${storeName}</div>
            ${this._printLogoTag(36)}
            <div class="receipt-title" style="color:var(--danger)">RENTAL CANCELLATION</div>
            ${agreement.branch_name ? `<div style="text-align:center;font-size:12px;color:#444;font-weight:600">${agreement.branch_name}</div>` : ''}
            <hr>
            <div class="receipt-row"><span>Agreement #:</span><span>${agreement.agreement_number}</span></div>
            <div class="receipt-row"><span>Cancelled:</span><span>${agreement.cancelled_at ? this.fmtDateTime(agreement.cancelled_at) : '—'}</span></div>
            ${agreement.customer_name ? `<div class="receipt-row"><span>Customer:</span><span>${agreement.customer_name}</span></div>` : ''}
            ${agreement.cancelled_by_name ? `<div class="receipt-row"><span>Cancelled By:</span><span>${agreement.cancelled_by_name}</span></div>` : ''}
            ${agreement.cancellation_reason ? `<div class="receipt-row"><span>Reason:</span><span>${agreement.cancellation_reason}</span></div>` : ''}
            <hr>
            ${items.map(i => `<div class="receipt-row"><span>${i.sku ? `<span style="font-size:11px;color:#555">${i.sku}</span> ` : ''}${i.product_name}</span><span>x${i.quantity}</span></div>`).join('')}
            <hr>
            ${wasBilled ? `
            <div class="receipt-row"><span>Original Payment</span><span>${(agreement.checkout_payment_method||'').replace(/_/g, ' ').toUpperCase()}</span></div>
            <div class="receipt-row receipt-total" style="color:var(--danger)"><span>AMOUNT VOIDED</span><span>${this.fmt(agreement.checkout_total)}</span></div>
            ` : `<div style="text-align:center;font-size:11px;color:#666;margin:6px 0">This rental was on hold — no payment had been collected, so nothing was charged or refunded.</div>`}
            <hr>
          </div>
        </div>
        <div class="modal-footer no-print">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-secondary" onclick="App.emailCancellationReceipt(${agreement.id},'${(agreement.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email</button>
          <button class="btn btn-primary" onclick="window.print()">🖨️ Print</button>
        </div>
      </div>`);
  },

  emailCancellationReceipt(agreementId, customerEmail) {
    this.showEmailModal('Email Cancellation Receipt', customerEmail, async (to) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-cancellation-receipt/${agreementId}`, { to });
        this.alert(`Cancellation receipt sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    });
  },

  async showRentalCheckoutModal() {
    const branches = this.currentUser.branches || [];
    const defaultBranch = branches.find(b => b.is_default) || branches[0] || null;
    // Same convention as the POS/Drawers branch bar: only employees with
    // multi_branch_access AND more than one assigned branch get a picker —
    // everyone else is locked to their own (default) branch.
    const isMultiBranch = this.currentUser.permissions?.multi_branch_access && branches.length > 1;
    const products = await this.api('GET', `/products?is_rental=1&active=1${defaultBranch ? '&branch_id='+defaultBranch.id : ''}`);
    // Only items actually available at this branch are offered for
    // selection — stock_qty already reflects branch-scoped stock when
    // branch_id is passed (see routes/products.js), so this nets that
    // against what's currently checked out elsewhere.
    this._rentalProducts = products.filter(p => (p.stock_qty - (p.rental_outstanding_qty||0)) > 0);
    this._rentalCustomers = [];
    this._rentalLineIdx = 0;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header">
          <span class="modal-title">New Rental</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group" style="position:relative"><label>Customer *</label>
              <input type="text" id="rc-customer-search" placeholder="Search customer…" autocomplete="off"
                oninput="App._filterRentalCustomers(this.value)" onfocus="App._filterRentalCustomers(this.value)">
              <input type="hidden" id="rc-customer" value="">
              <div id="rc-customer-dd" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
            </div>
            <div class="form-group"><label>Branch / Location *</label>
              ${isMultiBranch ? `
              <select id="rc-branch" onchange="App._refreshRentalCheckoutBranch()">
                <option value="">Select location…</option>
                ${branches.map(b=>`<option value="${b.id}" ${defaultBranch && b.id===defaultBranch.id?'selected':''}>${b.name}</option>`).join('')}
              </select>` : `
              <input type="text" value="${defaultBranch?.name || 'No branch assigned'}" disabled style="background:var(--bg-secondary)">
              <input type="hidden" id="rc-branch" value="${defaultBranch?.id || ''}">`}
            </div>
          </div>
          <div id="rc-customer-warning" style="display:none;margin-top:6px"></div>
          <div id="rc-unpaid-warning" style="display:none;margin-top:6px"></div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:-6px">Item availability below reflects stock at the selected location.</p>
          <div class="form-group"><label>Due Date *</label>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <input type="date" id="rc-duedate" value="${tomorrow}" oninput="App._onRentalDueDateChange()" style="flex:1;min-width:150px">
              <span id="rc-duedate-days" style="font-size:12px;color:var(--text-muted);white-space:nowrap"></span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
              <label style="font-size:11px;font-weight:400;color:var(--text-muted);white-space:nowrap">Or enter number of days:</label>
              <input type="number" id="rc-duedate-daysinput" min="1" step="1" placeholder="days" style="width:80px" oninput="App._onRentalDaysInputChange()">
            </div>
          </div>
          ${this._ratePlanSelectHtml('rc-rateplan', 'App._recalcRentalCheckoutEstimate()')}
          <hr style="margin:12px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>Items</strong>
            <button class="btn btn-sm btn-outline" onclick="App.addRentalCheckoutLine()">+ Add Item</button>
          </div>
          <div id="rental-checkout-lines"></div>
          <hr style="margin:12px 0">
          <strong>Additional Services</strong>
          <p style="font-size:11px;color:var(--text-muted);margin:2px 0 8px">Costs entered here are charged along with the rental fee when the cashier processes payment. The driver/operator themselves are assigned later, at issue/return.</p>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
              <input type="checkbox" id="rc-customer-pickup" onchange="App._toggleCustomerPickup()" style="width:16px;height:16px;cursor:pointer">
              Customer Pickup <span style="font-weight:400;color:var(--text-muted);font-size:11px">(customer collects the item themselves — no delivery)</span>
            </label>
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
              <input type="checkbox" id="rc-delivery" onchange="App._toggleRentalCreateService('delivery')" style="width:16px;height:16px;cursor:pointer">
              Delivery required
            </label>
          </div>
          <div id="rc-delivery-fields" style="display:none">
            <div class="form-group" style="max-width:220px"><label style="font-size:11px">Delivery Cost</label><input type="number" id="rc-delivery-cost" value="0" min="0" step="0.01" oninput="App._recalcRentalCheckoutEstimate()"></div>
            <div class="form-group"><label style="font-size:11px">Delivery Address *</label><textarea id="rc-delivery-address" rows="2" placeholder="Required — ask the customer where it's going, even if it's their own address"></textarea></div>
            ${this._rentalScheduleFieldsHtml('delivery')}
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
              <input type="checkbox" id="rc-pickup" onchange="App._toggleRentalCreateService('pickup')" style="width:16px;height:16px;cursor:pointer">
              Pickup (from customer) required
            </label>
          </div>
          <div id="rc-pickup-fields" style="display:none">
            <div class="form-group" style="max-width:220px"><label style="font-size:11px">Pickup Cost</label><input type="number" id="rc-pickup-cost" value="0" min="0" step="0.01" oninput="App._recalcRentalCheckoutEstimate()"></div>
            <div class="form-group"><label style="font-size:11px">Pickup Address *<a href="#" style="font-weight:400;text-transform:none;color:var(--primary);margin-left:6px" onclick="event.preventDefault();const d=document.getElementById('rc-delivery-address');if(!document.getElementById('rc-delivery')?.checked||!d||!d.value.trim()){App.alert('Tick Delivery required and enter the delivery address first','warning');return;}document.getElementById('rc-pickup-address').value=d.value">same as delivery address</a></label><textarea id="rc-pickup-address" rows="2" placeholder="Required — ask the customer where it's being collected from, even if it's their own address"></textarea></div>
            ${this._rentalScheduleFieldsHtml('pickup')}
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
              <input type="checkbox" id="rc-operator" onchange="App._toggleRentalCreateService('operator')" style="width:16px;height:16px;cursor:pointer">
              Operator required
            </label>
          </div>
          <div id="rc-operator-fields" class="form-group" style="display:none;max-width:220px">
            <label style="font-size:11px">Operator Fee</label><input type="number" id="rc-operator-fee" value="0" min="0" step="0.01" oninput="App._recalcRentalCheckoutEstimate()">
          </div>
          <hr style="margin:12px 0">
          <div id="rc-total-summary" style="background:var(--bg-secondary);border-radius:6px;padding:10px 12px;font-size:13px;margin-bottom:12px"></div>
          <div class="form-group"><label>Notes</label><textarea id="rc-agreement-notes" rows="2" placeholder="Optional notes for this rental…"></textarea></div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:8px">This places the rental on hold — a cashier will collect payment (cash or credit) and the rental period begins when it's finalized at the register.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.holdRentalCheckout()">Place on Hold</button>
        </div>
      </div>`);
    this.addRentalCheckoutLine();
    this._updateRentalDueDateBadge();
    this._recalcRentalCheckoutEstimate();
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#rc-customer-search') && !e.target.closest('#rc-customer-dd')) {
        const dd = document.getElementById('rc-customer-dd');
        if (dd) dd.style.display = 'none';
      }
    });
  },

  // New Rental: optional delivery / pickup booking, same as Rental Dispatch →
  // Schedule. Left blank, nothing is booked; "use due date" fills the pickup date.
  _rentalScheduleFieldsHtml(leg) {
    const id = f => `rc-${leg}-sched-${f}`;
    return `<div style="border:1px dashed var(--border);border-radius:6px;padding:8px 10px;margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Schedule ${leg} <span style="font-weight:400;text-transform:none">(optional — can also be done later from Rental Dispatch)</span></div>
      <div class="input-row">
        <div class="form-group"><label style="font-size:11px">Date${leg === 'pickup' ? ` <a href="#" style="font-weight:400;text-transform:none;color:var(--primary)" onclick="event.preventDefault();document.getElementById('${id('date')}').value=document.getElementById('rc-duedate')?.value||''">use due date</a>` : ''}</label><input type="date" id="${id('date')}"></div>
        <div class="form-group"><label style="font-size:11px">From</label><input type="time" id="${id('start')}" value="09:00"></div>
      </div>
      <div class="input-row">
        <div class="form-group"><label style="font-size:11px">To <span style="font-weight:400">(optional)</span></label><input type="time" id="${id('end')}"></div>
        ${this.can('rentals_issue') ? `<div class="form-group"><label style="font-size:11px">Driver</label><select id="${id('driver')}"><option value="">— Assign later —</option></select></div>` : '<div class="form-group"></div>'}
      </div>
      <div class="form-group" style="margin-bottom:0"><label style="font-size:11px">Notes for the driver</label><input id="${id('notes')}" placeholder="Gate code, contact on site…"></div>
    </div>`;
  },

  async _fillRentalScheduleDrivers(leg) {
    const sel = document.getElementById(`rc-${leg}-sched-driver`);
    if (!sel || sel.dataset.loaded) return;
    if (!this._dispatchDrivers) {
      try { this._dispatchDrivers = (await this.api('GET', '/employees')).filter(e => e.is_driver && e.active !== 0); } catch(e) { this._dispatchDrivers = []; }
    }
    sel.insertAdjacentHTML('beforeend', this._dispatchDrivers.map(d => `<option value="${d.id}">${d.first_name} ${d.last_name}</option>`).join(''));
    sel.dataset.loaded = '1';
  },

  // Returns the booking to send, null when none, or false (after alerting) when incomplete.
  _readRentalSchedule(leg) {
    const v = f => document.getElementById(`rc-${leg}-sched-${f}`)?.value || '';
    const date = v('date');
    if (!date) return null;
    if (!v('start')) { this.alert(`Choose the ${leg} start time, or clear the ${leg} date`, 'error'); return false; }
    return {
      start: new Date(`${date}T${v('start')}`).toISOString(),
      end: v('end') ? new Date(`${date}T${v('end')}`).toISOString() : null,
      driver_id: v('driver') || null,
      notes: v('notes').trim() || null,
    };
  },

  _toggleRentalCreateService(which) {
    const box = document.getElementById(`rc-${which}`);
    const fields = document.getElementById(`rc-${which}-fields`);
    if (fields) fields.style.display = box?.checked ? 'block' : 'none';
    // Delivery and Customer Pickup are mutually exclusive — the item can't
    // both be dropped off and collected by the customer.
    if (which === 'delivery' && box?.checked) {
      const cp = document.getElementById('rc-customer-pickup');
      if (cp) cp.checked = false;
      this._fillRentalScheduleDrivers('delivery');
    }
    if (which === 'pickup' && box?.checked) this._fillRentalScheduleDrivers('pickup');
    this._recalcRentalCheckoutEstimate();
  },

  _toggleCustomerPickup() {
    const box = document.getElementById('rc-customer-pickup');
    if (box?.checked) {
      const deliveryBox = document.getElementById('rc-delivery');
      if (deliveryBox?.checked) { deliveryBox.checked = false; this._toggleRentalCreateService('delivery'); }
    }
    this._recalcRentalCheckoutEstimate();
  },

  // Mirrors the main POS customer picker (App.selectCustomer/setCartCustomer)
  // — same Credit/Blocked/Tax Exempt badges, and a blocked account can be seen
  // but not selected (click shows the same alert instead of picking it).
  // Searches the server as you type (App._customerSearch); every customer
  // shown is kept in _rentalCustomers, which the rest of the rental form
  // reads the chosen customer from.
  async _filterRentalCustomers(q) {
    const dd = document.getElementById('rc-customer-dd');
    if (!dd) return;
    if (dd.style.display === 'none') { dd.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:13px">Searching…</div>'; dd.style.display = ''; }
    let matches;
    try { matches = await this._customerSearch('rental', q); }
    catch (e) { dd.innerHTML = `<div style="padding:10px;color:var(--danger);font-size:13px">${this.escapeAttr(e.message)}</div>`; return; }
    if (!matches) return;
    this._rentalCustomers = this._mergeCustomers(this._rentalCustomers, matches);
    const esc = v => this.escapeAttr(v ?? '');
    if (!matches.length) {
      dd.innerHTML = this._addCustomerRowHtml('rental') + '<div style="padding:10px;color:var(--text-muted);font-size:13px">No customers found</div>';
      dd.style.display = '';
      return;
    }
    dd.innerHTML = this._addCustomerRowHtml('rental') + matches.map(c => {
      const blocked = c.customer_type === 'credit' && c.account_blocked;
      const typeTag = c.customer_type === 'credit'
        ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:#e3f2fd;color:#1565c0;margin-left:4px">Credit</span>`
        : '';
      const blockedTag = blocked
        ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:#ffebee;color:#c62828;margin-left:4px">BLOCKED</span>`
        : '';
      const taxExemptTag = c.tax_exempt
        ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:#e8f5e9;color:#2e7d32;margin-left:4px">Tax Exempt</span>`
        : '';
      const clickHandler = blocked
        ? `App.alert('Account blocked: overdue balance must be settled before making purchases.','error')`
        : `App._selectRentalCustomer(${c.id})`;
      return `<div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text);${blocked?'opacity:0.6':''}" onclick="${clickHandler}">
        <div><strong>${esc(c.first_name)} ${esc(c.last_name)}</strong><span style="color:var(--text-muted);font-size:12px;margin-left:4px">${esc(c.customer_number)}</span>${typeTag}${blockedTag}${taxExemptTag}</div>
      </div>`;
    }).join('');
    dd.style.display = '';
  },

  // Mirrors lib/rentals.js's RENTAL_REQUIREMENTS exactly (same dual-
  // maintenance pattern as App._permissionTree / PERMISSION_TREE) — only
  // used here to preview what assertRentalCustomerEligible would reject, so
  // staff see it before attempting to place the rental on hold rather than
  // only after a failed submit.
  _rentalMissingFieldLabels(c) {
    const reqs = [
      { label: 'Photo ID (type & number)', ok: !!(c.rental_id_type && c.rental_id_number) },
      { label: 'ID scan', ok: !!c.rental_id_scan_path },
      { label: 'Proof of address', ok: !!c.rental_address_proof_path },
      { label: 'Reference 1 (name & phone)', ok: !!(c.rental_reference_name && c.rental_reference_phone) },
      { label: 'Reference 1 ID scan', ok: !!c.rental_reference_id_path },
      { label: 'Reference 2 (name & phone)', ok: !!(c.rental_reference2_name && c.rental_reference2_phone) },
      { label: 'Reference 3 (name & phone)', ok: !!(c.rental_reference3_name && c.rental_reference3_phone) },
    ];
    return reqs.filter(r => !r.ok).map(r => r.label);
  },

  // Mirrors lib/rentals.js's isCreditCustomerType — customer_type is stored
  // with mixed case ('Credit'/'credit'). A credit customer pays no rental
  // deposit (see depositWaiver there).
  _isCreditCustomerType(t) { return String(t || '').trim().toLowerCase() === 'credit'; },

  // Label for a waived rental deposit, keyed by depositWaiver's reason.
  _depositWaivedLabel(reason) { return reason === 'credit' ? 'not required — credit account' : 'waived — operator provided'; },

  async _selectRentalCustomer(id) {
    let c = (this._rentalCustomers || []).find(x => x.id === id);
    if (!c) {
      try { c = await this._customerById(id); } catch (e) { c = null; }
      if (!c) return;
      this._rentalCustomers = this._mergeCustomers(this._rentalCustomers, [c]);
    }
    const idEl = document.getElementById('rc-customer');
    const searchEl = document.getElementById('rc-customer-search');
    const dd = document.getElementById('rc-customer-dd');
    if (idEl) idEl.value = id;
    if (searchEl) searchEl.value = `${c.first_name} ${c.last_name}`;
    if (dd) dd.style.display = 'none';

    const warnEl = document.getElementById('rc-customer-warning');
    if (warnEl) {
      if (!c.is_rental_customer) {
        warnEl.style.display = '';
        warnEl.innerHTML = `<div style="padding:8px 10px;background:#fff3f3;border:1px solid #f44336;border-radius:6px;color:#c62828;font-size:12px">&#9888; Not set up as a rental customer yet — edit them first to add photo ID, proof of address, and references.</div>`;
      } else {
        const missing = this._rentalMissingFieldLabels(c);
        if (!missing.length) {
          warnEl.style.display = 'none';
          warnEl.innerHTML = '';
        } else if (c.rental_preapproved) {
          warnEl.style.display = '';
          warnEl.innerHTML = `<div style="padding:8px 10px;background:#fff8e1;border:1px solid #f9a825;border-radius:6px;color:#8d6e00;font-size:12px">&#9888; Preapproved, but still missing: ${missing.join(', ')} — collect when possible.</div>`;
        } else {
          warnEl.style.display = '';
          warnEl.innerHTML = `<div style="padding:8px 10px;background:#fff3f3;border:1px solid #f44336;border-radius:6px;color:#c62828;font-size:12px">&#9888; Missing ${missing.join(', ')} — this rental can't be placed on hold until it's added (or the customer is marked Preapproved).</div>`;
        }
      }
    }
    this._showRentalUnpaidReturnsWarning(id);
    // A credit customer pays no deposit, so the estimate depends on who's picked.
    this._recalcRentalCheckoutEstimate();
  },

  // A customer with a returned rental still unpaid (bearer dropped it off,
  // nobody settled) is blocked from new rentals server-side — see
  // lib/rentals.js's assertNoUnpaidRentalReturns. Surfaced here up front so
  // staff don't build out the whole rental before finding out.
  async _showRentalUnpaidReturnsWarning(customerId) {
    const el = document.getElementById('rc-unpaid-warning');
    if (!el) return;
    el.style.display = 'none';
    el.innerHTML = '';
    let unpaid = [];
    try { unpaid = await this.api('GET', `/rentals/agreements?view=awaiting_payment&customer_id=${customerId}`); } catch(e) { return; }
    if (document.getElementById('rc-customer')?.value != customerId || !unpaid.length) return;
    const total = unpaid.reduce((sum, a) => sum + (a.balance_due || 0), 0);
    el.style.display = '';
    el.innerHTML = `<div style="padding:8px 10px;background:#fff3f3;border:1px solid #f44336;border-radius:6px;color:#c62828;font-size:12px">&#9888; Blocked from renting — returned rental${unpaid.length === 1 ? '' : 's'} not paid: ${unpaid.map(a => a.agreement_number).join(', ')} (${this.fmt(total)} owed). Collect the balance at the register first.</div>`;
  },

  addRentalCheckoutLine() {
    const container = document.getElementById('rental-checkout-lines');
    if (!container) return;
    const idx = this._rentalLineIdx++;
    const wrap = document.createElement('div');
    wrap.id = `rental-line-${idx}`;
    wrap.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:8px';
    wrap.innerHTML = `
      <div style="display:flex;gap:6px;align-items:flex-start">
        <button type="button" id="rl-prod-btn-${idx}" onclick="App._openRentalItemPicker(${idx})" style="flex:2;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px;background:#fff;text-align:left;cursor:pointer">Select item…</button>
        <input type="hidden" id="rl-prod-${idx}" value="">
        <input type="number" id="rl-qty-${idx}" value="1" min="1" style="width:70px;padding:6px;border:1px solid var(--border);border-radius:4px" onchange="App._onRentalLineProductChange(${idx})">
        <input type="text" id="rl-cond-${idx}" placeholder="Condition out (optional)" style="flex:2;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px">
        <span id="rl-warn-${idx}" style="font-size:11px;color:var(--danger);align-self:center"></span>
      </div>
      <div id="rl-rate-${idx}" style="font-size:11px;color:var(--text-muted);margin-top:4px"></div>
      <div id="rl-accessories-${idx}"></div>`;
    container.appendChild(wrap);
  },

  _updateRentalLineAvail(idx) {
    const hidden = document.getElementById(`rl-prod-${idx}`);
    const qtyEl = document.getElementById(`rl-qty-${idx}`);
    const warnEl = document.getElementById(`rl-warn-${idx}`);
    if (!hidden || !qtyEl || !warnEl) return;
    const avail = parseInt(hidden.dataset.avail) || 0;
    const qty = parseInt(qtyEl.value) || 0;
    warnEl.textContent = qty > avail ? `Only ${avail} available` : '';
  },

  // Loads and renders the mandatory/optional accessories for whichever item
  // is currently selected on this checkout line — mandatory ones are always
  // included at no cost; optional ones are checkboxes that add their own fee.
  // Also renders the item's Daily/Weekly/Monthly rate card and refreshes the
  // running estimate at the bottom of the form.
  async _onRentalLineProductChange(idx) {
    this._updateRentalLineAvail(idx);
    const hidden = document.getElementById(`rl-prod-${idx}`);
    const accEl = document.getElementById(`rl-accessories-${idx}`);
    const rateEl = document.getElementById(`rl-rate-${idx}`);
    if (!hidden || !accEl) return;
    const productId = hidden.value;
    if (!productId) {
      accEl.innerHTML = '';
      if (rateEl) rateEl.innerHTML = '';
      this._recalcRentalCheckoutEstimate();
      return;
    }
    const product = (this._rentalProducts || []).find(p => String(p.id) === String(productId));
    if (rateEl && product) {
      const parts = [`${this.fmt(product.rental_rate)}/day`];
      if (product.rental_classification === 'equipment') {
        if (product.rental_weekly_rate) parts.push(`${this.fmt(product.rental_weekly_rate)}/week`);
        if (product.rental_monthly_rate) parts.push(`${this.fmt(product.rental_monthly_rate)}/month`);
        if (product.rental_hourly_rate) parts.push(`${this.fmt(product.rental_hourly_rate)}/hr`);
      } else {
        const { weekTierDayRate, monthTierDayRate } = this._toolTierDayRates(product.rental_rate);
        parts.push(`${this.fmt(weekTierDayRate)}/day after 7 days`, `${this.fmt(monthTierDayRate)}/day after 28 days`);
      }
      rateEl.innerHTML = `Rate: ${parts.join(' · ')}`;
    }
    const accessories = await this.api('GET', `/products/${productId}/accessories`);
    if (!document.getElementById(`rl-accessories-${idx}`)) return;
    this._rentalLineAccessories = this._rentalLineAccessories || {};
    this._rentalLineAccessories[idx] = accessories;
    accEl.innerHTML = !accessories.length ? '' : `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);font-size:12px">
      ${accessories.map(a => a.is_mandatory
        ? `<div style="color:var(--text-muted)">✓ Includes ${a.name} <span style="font-size:11px">(mandatory, no charge)</span></div>`
        : `<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" class="rl-acc-${idx}" value="${a.accessory_product_id}" onchange="App._recalcRentalCheckoutEstimate()" style="width:auto"> ${a.name} <span style="color:var(--text-muted)">(+${this.fmt(a.rental_rate)}/day)</span></label>`
      ).join('')}
    </div>`;
    this._recalcRentalCheckoutEstimate();
  },

  // Rate plan (daily/weekly/monthly) chosen when setting up a rental — a cap
  // on the tier billed, never a way up. Mirrors lib/rentalPricing.js's
  // earnedRatePlan/effectiveRatePlan; the server re-checks the choice.
  _RATE_PLANS: ['daily', 'weekly', 'monthly'],
  _earnedRatePlan(classification, days) {
    if (classification === 'equipment') return days >= 28 ? 'monthly' : days >= 7 ? 'weekly' : 'daily';
    return days > 28 ? 'monthly' : days >= 7 ? 'weekly' : 'daily';
  },
  _effectiveRatePlan(classification, days, ratePlan) {
    const earned = this._earnedRatePlan(classification, days);
    if (!this._RATE_PLANS.includes(ratePlan)) return earned;
    return this._RATE_PLANS[Math.min(this._RATE_PLANS.indexOf(earned), this._RATE_PLANS.indexOf(ratePlan))];
  },
  _ratePlanLabel(plan) {
    return plan ? `${plan[0].toUpperCase()}${plan.slice(1)} rate` : 'Automatic (by rental length)';
  },
  _ratePlanSelectHtml(id, onchange, selected = '') {
    const opt = (v, label) => `<option value="${v}" ${(selected || '') === v ? 'selected' : ''}>${label}</option>`;
    return `<div class="form-group"><label>Rate</label>
      <select id="${id}" onchange="${onchange}" onfocus="${onchange}">
        ${opt('', 'Automatic — based on rental length')}${opt('daily', 'Daily rate')}${opt('weekly', 'Weekly rate')}${opt('monthly', 'Monthly rate')}
      </select>
      <div id="${id}-note" style="font-size:11px;color:var(--text-muted);margin-top:4px"></div>
    </div>`;
  },
  // Disables the tiers the rental's length doesn't earn (for any of its
  // items — `classifications` of the chargeable lines) and drops an
  // ineligible choice back to Automatic, saying so.
  _refreshRatePlanOptions(id, days, classifications) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const note = document.getElementById(`${id}-note`);
    // No items picked yet: judge by the most lenient rule (the server has the final say).
    const classes = classifications.length ? classifications : ['equipment'];
    const allowed = plan => days != null && classes.every(c => this._RATE_PLANS.indexOf(plan) <= this._RATE_PLANS.indexOf(this._earnedRatePlan(c, days)));
    const need = { weekly: 'needs 7+ days', monthly: classes.includes('equipment') && !classes.some(c => c !== 'equipment') ? 'needs 28+ days' : 'needs more than 28 days' };
    for (const opt of sel.options) {
      if (!opt.value || opt.value === 'daily') continue;
      opt.disabled = !allowed(opt.value);
      opt.textContent = `${this._ratePlanLabel(opt.value)}${opt.disabled ? ` (${need[opt.value]})` : ''}`;
    }
    let msg = '';
    if (sel.value && sel.selectedOptions[0]?.disabled) {
      msg = `${this._ratePlanLabel(sel.value)} needs a longer rental — set back to Automatic.`;
      sel.value = '';
    }
    const explain = {
      '': 'Uses the rate the rental length earns (weekly from 7 days, monthly from 28+).',
      daily: 'Every day is billed at the daily rate, however long the rental runs.',
      weekly: 'Billed at the weekly rate — never the monthly rate, even if it runs past a month.',
      monthly: 'Billed at the monthly rate. If it comes back early, it drops to the rate the actual length earns.',
    };
    if (note) note.textContent = msg || explain[sel.value];
  },

  // Client-side port of lib/rentalPricing.js's calculateRentalFee — used only
  // to show a live estimate on the New Rental form before the hold is placed.
  // The server recomputes this for real (and is authoritative) at finalize
  // time using the actual checkout instant, so this must stay logically
  // identical to that module or the displayed estimate will silently drift
  // from what's actually billed. Returns the UNROUNDED per-unit fee — same
  // reasoning as lib/rentalPricing.js: round once, after the caller
  // multiplies by quantity, not before.
  _calcRentalFeeEstimate({ classification, dailyRate, weeklyRate, monthlyRate, hourlyRate, start, end, ratePlan }) {
    const totalMs = Math.max(0, end - start);
    const totalHours = Math.floor(totalMs / 3600000);
    const totalCalendarDays = totalHours / 24;
    const daily = dailyRate || 0;
    const plan = this._effectiveRatePlan(classification, totalCalendarDays, ratePlan);

    // Tools: 7-28 days bills the WHOLE rental at 85% of the daily rate per
    // day; above 28 days bills the whole rental at 75% of that (see the
    // matching branch in lib/rentalPricing.js — must stay identical). A
    // chosen rate plan caps the tier (daily plan = full daily rate).
    if (classification !== 'equipment' && plan !== 'daily') {
      const weekTierDayRate = daily * 0.85;
      const perDayRate = plan === 'monthly' ? weekTierDayRate * 0.75 : weekTierDayRate;
      return totalCalendarDays * perDayRate;
    }
    if (classification !== 'equipment' && totalCalendarDays >= 7) return totalCalendarDays * daily;

    const months = plan === 'monthly' ? Math.floor(totalCalendarDays / 28) : 0;
    const remAfterMonths = totalCalendarDays - months * 28;
    const weeks = plan === 'daily' ? 0 : Math.floor(remAfterMonths / 7);
    const remAfterWeeks = remAfterMonths - weeks * 7;
    let days = Math.floor(remAfterWeeks);
    let remainderHours = (remAfterWeeks - days) * 24;

    const hourly = hourlyRate || 0;
    let hoursBilled = 0;

    if (classification === 'equipment') {
      if (remainderHours > 8) { days += 1; remainderHours = 0; }
      else hoursBilled = remainderHours;
    } else {
      hoursBilled = remainderHours;
    }

    const monthlyFee = months * (monthlyRate || 0);
    const weeklyFee = weeks * (weeklyRate || 0);
    const dailyFee = days * daily;
    const hourlyFee = classification === 'equipment' ? hoursBilled * hourly : hoursBilled * (daily / 24);

    return monthlyFee + weeklyFee + dailyFee + hourlyFee;
  },

  // Recomputes the running estimate shown on the New Rental form — every
  // line's tiered fee (main item + checked optional accessories) from "now"
  // to the chosen due date, plus tax, plus delivery/pickup/operator fees.
  // Mirrors the double-charge model used at finalize (the deposit equals the
  // rental fee), so the estimated total matches what actually gets charged.
  // Same floored-to-the-hour window the rental fee is actually billed
  // against (see _calcRentalFeeEstimate) — not a separate midnight-to-
  // midnight count, which could disagree with the total by up to a day
  // depending on what time of day it is right now.
  _rentalDaysFromDueDate(dueDateStr) {
    if (!dueDateStr) return null;
    const start = new Date();
    const end = new Date(`${dueDateStr}T${start.toISOString().slice(11,19)}.000Z`);
    const totalCalendarDays = Math.floor(Math.max(0, end - start) / 3600000) / 24;
    return Math.max(1, Math.ceil(totalCalendarDays));
  },

  _updateRentalDueDateBadge() {
    const badge = document.getElementById('rc-duedate-days');
    if (!badge) return;
    const dueDateStr = document.getElementById('rc-duedate')?.value;
    const days = this._rentalDaysFromDueDate(dueDateStr);
    badge.textContent = days ? `(${days} day${days===1?'':'s'})` : '';
  },

  _onRentalDueDateChange() {
    this._updateRentalDueDateBadge();
    this._recalcRentalCheckoutEstimate();
  },

  // Reverse direction: typing a day count writes a computed due date back
  // into rc-duedate, then runs the same update path as picking a date
  // directly so the badge and estimate stay in sync.
  _onRentalDaysInputChange() {
    const n = parseInt(document.getElementById('rc-duedate-daysinput')?.value);
    if (!n || n < 1) return;
    const dateEl = document.getElementById('rc-duedate');
    if (dateEl) dateEl.value = new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    this._onRentalDueDateChange();
  },

  _recalcRentalCheckoutEstimate() {
    const summaryEl = document.getElementById('rc-total-summary');
    if (!summaryEl) return;
    const dueDateStr = document.getElementById('rc-duedate')?.value;
    const rows = [];
    let feeSubtotal = 0, taxTotal = 0;
    let start, end;
    // Rate picker first: which tiers this length earns for the items chosen.
    const lineClasses = [];
    document.querySelectorAll('#rental-checkout-lines [id^="rental-line-"]').forEach(line => {
      const idx = line.id.replace('rental-line-', '');
      const product = (this._rentalProducts || []).find(p => String(p.id) === String(document.getElementById(`rl-prod-${idx}`)?.value));
      if (product) lineClasses.push(product.rental_classification || 'tool');
      const accs = (this._rentalLineAccessories || {})[idx] || [];
      document.querySelectorAll(`.rl-acc-${idx}:checked`).forEach(cb => {
        const acc = accs.find(a => String(a.accessory_product_id) === String(cb.value));
        if (acc) lineClasses.push(acc.rental_classification || 'tool');
      });
    });
    const planStart = new Date();
    const planDays = dueDateStr ? Math.floor(Math.max(0, new Date(`${dueDateStr}T${planStart.toISOString().slice(11,19)}.000Z`) - planStart) / 3600000) / 24 : null;
    this._refreshRatePlanOptions('rc-rateplan', planDays, lineClasses);
    const ratePlan = document.getElementById('rc-rateplan')?.value || null;
    if (dueDateStr) {
      start = new Date();
      end = new Date(`${dueDateStr}T${start.toISOString().slice(11,19)}.000Z`);
      document.querySelectorAll('#rental-checkout-lines [id^="rental-line-"]').forEach(line => {
        const idx = line.id.replace('rental-line-', '');
        const productId = document.getElementById(`rl-prod-${idx}`)?.value;
        if (!productId) return;
        const product = (this._rentalProducts || []).find(p => String(p.id) === String(productId));
        if (!product) return;
        const qty = parseInt(document.getElementById(`rl-qty-${idx}`)?.value) || 0;
        if (qty <= 0) return;
        const fee = Math.round(this._calcRentalFeeEstimate({
          classification: product.rental_classification, dailyRate: product.rental_rate,
          weeklyRate: product.rental_weekly_rate, monthlyRate: product.rental_monthly_rate,
          hourlyRate: product.rental_hourly_rate, start, end, ratePlan,
        }) * qty * 100) / 100;
        rows.push({ label: `${product.name} × ${qty}`, fee });
        feeSubtotal += fee;
        taxTotal += fee * (product.tax_rate || 0) / 100;

        const accs = (this._rentalLineAccessories || {})[idx] || [];
        document.querySelectorAll(`.rl-acc-${idx}:checked`).forEach(cb => {
          const acc = accs.find(a => String(a.accessory_product_id) === String(cb.value));
          if (!acc) return;
          const accFee = Math.round(this._calcRentalFeeEstimate({
            classification: acc.rental_classification, dailyRate: acc.rental_rate,
            weeklyRate: acc.rental_weekly_rate, monthlyRate: acc.rental_monthly_rate,
            hourlyRate: acc.rental_hourly_rate, start, end, ratePlan,
          }) * qty * 100) / 100;
          rows.push({ label: `+ ${acc.name} × ${qty}`, fee: accFee });
          feeSubtotal += accFee;
          taxTotal += accFee * (acc.tax_rate || 0) / 100;
        });
      });
    }

    if (!dueDateStr || !rows.length) {
      summaryEl.innerHTML = `<span style="color:var(--text-muted)">Select a due date and at least one item to see an estimated total.</span>`;
      return;
    }

    const deliveryFee = document.getElementById('rc-delivery')?.checked ? parseFloat(document.getElementById('rc-delivery-cost')?.value) || 0 : 0;
    const pickupFee = document.getElementById('rc-pickup')?.checked ? parseFloat(document.getElementById('rc-pickup-cost')?.value) || 0 : 0;
    const operatorRequired = document.getElementById('rc-operator')?.checked || false;
    const operatorFee = operatorRequired ? parseFloat(document.getElementById('rc-operator-fee')?.value) || 0 : 0;
    const servicesTotal = deliveryFee + pickupFee + operatorFee;
    // Sales Total (fee + tax) is what gets charged as the non-refundable
    // sale AND mirrored as the refundable deposit — see PATCH .../checkout
    // in routes/rentals.js — so what's actually collected at the register is
    // two times Sales Total, plus service fees. When an operator is required,
    // our own staff runs the equipment (not the customer), so there's
    // nothing to protect a deposit against — it's waived entirely.
    const salesTotal = feeSubtotal + taxTotal;
    const rentalCustomerId = parseInt(document.getElementById('rc-customer')?.value) || null;
    const rentalCustomer = (this._rentalCustomers || []).find(c => c.id === rentalCustomerId);
    const depositWaivedReason = operatorRequired ? 'operator' : (this._isCreditCustomerType(rentalCustomer?.customer_type) ? 'credit' : null);
    const depositTotal = depositWaivedReason ? 0 : salesTotal;
    const grandTotal = salesTotal + depositTotal + servicesTotal;
    const days = this._rentalDaysFromDueDate(dueDateStr);

    summaryEl.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px">Estimated Total — ${days} day${days===1?'':'s'}${ratePlan ? ` · ${this._ratePlanLabel(ratePlan)}` : ''}</div>
      ${rows.map(r => `<div style="display:flex;justify-content:space-between"><span>${r.label}</span><span>${this.fmt(r.fee)}</span></div>`).join('')}
      <div style="display:flex;justify-content:space-between"><span>Sub-Total Amount</span><span>${this.fmt(feeSubtotal)}</span></div>
      <div style="display:flex;justify-content:space-between"><span>Sales Tax</span><span>${this.fmt(taxTotal)}</span></div>
      <div style="display:flex;justify-content:space-between"><span>Sales Total</span><span>${this.fmt(salesTotal)}</span></div>
      <div style="display:flex;justify-content:space-between"><span>Rental Deposit${depositWaivedReason ? ` <span style="color:var(--text-muted);font-weight:400">(${this._depositWaivedLabel(depositWaivedReason)})</span>` : ''}</span><span>${this.fmt(depositTotal)}</span></div>
      ${deliveryFee ? `<div style="display:flex;justify-content:space-between"><span>Delivery Fee</span><span>${this.fmt(deliveryFee)}</span></div>` : ''}
      ${pickupFee ? `<div style="display:flex;justify-content:space-between"><span>Pickup Fee</span><span>${this.fmt(pickupFee)}</span></div>` : ''}
      ${operatorFee ? `<div style="display:flex;justify-content:space-between"><span>Operator Fee</span><span>${this.fmt(operatorFee)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-weight:700;border-top:1px solid var(--border);margin-top:6px;padding-top:6px"><span>Grand Total</span><span>${this.fmt(grandTotal)}</span></div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:6px">Estimated — the real charge is computed when payment is processed, based on the exact start time.</p>
    `;
  },

  // Re-fetches rental items scoped to the newly-selected branch and refreshes
  // every existing line's availability numbers in place (keeping whatever
  // item/qty the user already picked). A line's item is cleared if it isn't
  // available at the newly-selected branch.
  async _refreshRentalCheckoutBranch() {
    const branchId = document.getElementById('rc-branch')?.value;
    const all = branchId ? await this.api('GET', `/products?is_rental=1&active=1&branch_id=${branchId}`) : [];
    this._rentalProducts = all.filter(p => (p.stock_qty - (p.rental_outstanding_qty||0)) > 0);
    if (!document.getElementById('rc-branch')) return;
    document.querySelectorAll('#rental-checkout-lines [id^="rental-line-"]').forEach(line => {
      const idx = line.id.replace('rental-line-','');
      const hidden = document.getElementById(`rl-prod-${idx}`);
      const btn = document.getElementById(`rl-prod-btn-${idx}`);
      if (!hidden) return;
      const stillAvailable = this._rentalProducts.find(p => String(p.id) === String(hidden.value));
      if (stillAvailable) {
        const avail = stillAvailable.stock_qty - (stillAvailable.rental_outstanding_qty||0);
        hidden.dataset.avail = avail;
        if (btn) btn.textContent = `${stillAvailable.name} (${avail} available)`;
      } else {
        hidden.value = '';
        delete hidden.dataset.avail;
        if (btn) btn.textContent = 'Select item…';
      }
      this._updateRentalLineAvail(idx);
      if (hidden.value) this._onRentalLineProductChange(idx);
      else { const accEl = document.getElementById(`rl-accessories-${idx}`); if (accEl) accEl.innerHTML = ''; }
    });
    this._recalcRentalCheckoutEstimate();
  },

  // ─── Rental item picker popup (New Rental screen) ──────────────────────
  // A custom overlay rather than showModal()/closeModal(), which are a
  // single-modal singleton that would tear down the New Rental modal (and
  // everything the user already filled in) the moment this opens on top of it.
  _openRentalItemPicker(idx) {
    document.querySelector('.rental-item-picker-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'rental-item-picker-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1100;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px;max-height:80vh;display:flex;flex-direction:column">
        <div class="modal-header">
          <span class="modal-title">Select Rental Item</span>
          <button type="button" class="modal-close" onclick="App._closeRentalItemPicker()">✕</button>
        </div>
        <div class="modal-body" style="overflow-y:auto">
          <input type="text" id="rl-picker-search" placeholder="Search items…" autocomplete="off" oninput="App._filterRentalItemPicker(${idx})">
          <div id="rl-picker-list" style="margin-top:10px"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this._renderRentalItemPickerList(idx, this._rentalProducts || []);
    setTimeout(() => document.getElementById('rl-picker-search')?.focus(), 50);
  },

  _closeRentalItemPicker() {
    document.querySelector('.rental-item-picker-overlay')?.remove();
  },

  _filterRentalItemPicker(idx) {
    const q = (document.getElementById('rl-picker-search')?.value || '').toLowerCase();
    const filtered = (this._rentalProducts || []).filter(p => !q || p.name.toLowerCase().includes(q) || (p.sku||'').toLowerCase().includes(q));
    this._renderRentalItemPickerList(idx, filtered);
  },

  _renderRentalItemPickerList(idx, products) {
    const list = document.getElementById('rl-picker-list');
    if (!list) return;
    if (!products.length) { list.innerHTML = '<div class="empty-state"><p>No available items at this location.</p></div>'; return; }
    list.innerHTML = products.map(p => {
      const avail = p.stock_qty - (p.rental_outstanding_qty||0);
      return `<div class="nav-item" style="padding:10px;cursor:pointer;color:var(--text);border-bottom:1px solid var(--border);border-radius:4px" onclick="App._pickRentalItem(${idx},${p.id})">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div><strong>${p.name}</strong><div style="font-size:11px;color:var(--text-muted)">${p.sku}</div></div>
          <span class="badge-pill badge-info" style="white-space:nowrap">${avail} available</span>
        </div>
      </div>`;
    }).join('');
  },

  _pickRentalItem(idx, productId) {
    const product = (this._rentalProducts || []).find(p => p.id === productId);
    if (!product) return;
    const avail = product.stock_qty - (product.rental_outstanding_qty||0);
    const hidden = document.getElementById(`rl-prod-${idx}`);
    const btn = document.getElementById(`rl-prod-btn-${idx}`);
    if (hidden) { hidden.value = productId; hidden.dataset.avail = avail; }
    if (btn) btn.textContent = `${product.name} (${avail} available)`;
    this._closeRentalItemPicker();
    this._onRentalLineProductChange(idx);
  },

  async holdRentalCheckout() {
    const customer_id = document.getElementById('rc-customer').value;
    const branch_id = document.getElementById('rc-branch').value || null;
    const due_date = document.getElementById('rc-duedate').value;
    if (!customer_id) { this.alert('Please select a customer', 'error'); return; }
    if (!branch_id) { this.alert('Please select a branch/location', 'error'); return; }
    if (!due_date) { this.alert('Please select a due date', 'error'); return; }
    const items = [];
    document.querySelectorAll('#rental-checkout-lines [id^="rental-line-"]').forEach(line => {
      const idx = line.id.replace('rental-line-','');
      const product_id = document.getElementById(`rl-prod-${idx}`)?.value;
      const quantity = parseInt(document.getElementById(`rl-qty-${idx}`)?.value) || 0;
      const condition_out = document.getElementById(`rl-cond-${idx}`)?.value.trim() || null;
      const accessory_ids = Array.from(document.querySelectorAll(`.rl-acc-${idx}:checked`)).map(cb => cb.value);
      if (product_id && quantity > 0) items.push({ product_id, quantity, condition_out, accessory_ids });
    });
    if (!items.length) { this.alert('Add at least one rental item', 'error'); return; }
    const deliveryRequired = document.getElementById('rc-delivery').checked;
    const pickupRequired = document.getElementById('rc-pickup').checked;
    const operatorRequired = document.getElementById('rc-operator').checked;
    const customerPickup = document.getElementById('rc-customer-pickup').checked;
    if (deliveryRequired && !document.getElementById('rc-delivery-address')?.value.trim()) {
      this.alert("Enter the delivery address — ask the customer where it's going, even if it's their own address", 'error');
      document.getElementById('rc-delivery-address')?.focus();
      return;
    }
    if (pickupRequired && !document.getElementById('rc-pickup-address')?.value.trim()) {
      this.alert("Enter the pickup address — ask the customer where it's being collected from, even if it's their own address", 'error');
      document.getElementById('rc-pickup-address')?.focus();
      return;
    }
    const delivery_schedule = deliveryRequired ? this._readRentalSchedule('delivery') : null;
    const pickup_schedule = pickupRequired ? this._readRentalSchedule('pickup') : null;
    if (delivery_schedule === false || pickup_schedule === false) return;
    try {
      const agreement = await this.api('POST', '/rentals/agreements', {
        delivery_schedule, pickup_schedule,
        rate_plan: document.getElementById('rc-rateplan')?.value || null,
        customer_id, branch_id, employee_id: this.currentUser.id, due_date, items,
        notes: document.getElementById('rc-agreement-notes')?.value.trim() || null,
        delivery_required: deliveryRequired ? 1 : 0,
        delivery_cost: deliveryRequired ? parseFloat(document.getElementById('rc-delivery-cost').value) || 0 : 0,
        delivery_address: deliveryRequired ? (document.getElementById('rc-delivery-address')?.value.trim() || null) : null,
        pickup_required: pickupRequired ? 1 : 0,
        pickup_cost: pickupRequired ? parseFloat(document.getElementById('rc-pickup-cost').value) || 0 : 0,
        pickup_address: pickupRequired ? document.getElementById('rc-pickup-address').value.trim() : null,
        operator_required: operatorRequired ? 1 : 0,
        operator_fee: operatorRequired ? parseFloat(document.getElementById('rc-operator-fee').value) || 0 : 0,
        customer_pickup: customerPickup ? 1 : 0,
      });
      this.closeModal();
      const booked = [delivery_schedule && 'delivery', pickup_schedule && 'pickup'].filter(Boolean);
      this.alert(`Rental ${agreement.agreement_number} placed on hold${booked.length ? `, ${booked.join(' and ')} scheduled` : ''} — a cashier can recall it from Held Orders in the POS to collect payment`);
      for (const w of agreement.schedule_warnings || []) {
        this.alert(w.type === 'driver_busy'
          ? `Heads up: this driver also has the ${w.leg} for ${w.agreement_number} at ${this.fmtDateTime(w.at)}`
          : `Heads up: the pickup is after the rental is due back (${this.fmtDate(w.due_date + 'T12:00:00')}) — time past the due date is billed as late unless the rental is paused`, 'warning');
      }
      this.renderRentals();
      this.updateHoldBadge();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Finalize a held rental (collect payment) ────────────────────────────

  async showFinalizeRentalModal(id) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    if (a.status !== 'pending') { this.alert('This rental is not awaiting checkout', 'warning'); return; }
    // Reset per-modal upload state — tracked outside the DOM since the PO
    // attachment uploads to the agreement immediately (before Complete
    // Checkout is even clicked), independent of the rest of this form.
    this._rfPoAttachmentPath = a.customer_po_attachment_path || null;
    this._rfPoAttachmentName = a.customer_po_attachment_name || null;
    this._rfEstimatedTotal = a.estimated_total || 0;
    this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header">
          <span class="modal-title">Process Payment — ${a.agreement_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row" style="margin-bottom:10px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Customer</label><div>${a.customer_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Due Date</label><div>${this.fmtDate(a.due_date)}</div></div>
          </div>
          <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:12px">
            ${a.items.filter(i=>!i.parent_item_id).map(i => {
              const accs = a.items.filter(x => x.parent_item_id === i.id);
              return `<div style="font-size:13px;margin-bottom:4px;display:flex;justify-content:space-between">
                <span><strong>${i.product_name}</strong> × ${i.quantity}
                ${accs.length ? `<div style="font-size:11px;color:var(--text-muted)">+ ${accs.map(x=>x.product_name).join(', ')}</div>` : ''}</span>
                <span>${this.fmt(i.estimated_rental_fee || 0)}</span>
              </div>`;
            }).join('')}
            <div style="border-top:1px dashed var(--border);margin-top:8px;padding-top:8px;font-size:13px">
              <div>Sub-Total Amount <span style="float:right">${this.fmt(a.estimated_rental_subtotal || 0)}</span></div>
              <div>Sales Tax <span style="float:right">${this.fmt(a.estimated_tax || 0)}</span></div>
              <div>Sales Total <span style="float:right">${this.fmt((a.estimated_rental_subtotal || 0) + (a.estimated_tax || 0))}</span></div>
              <div>Rental Deposit${a.deposit_waived_reason ? ` <span style="color:var(--text-muted)">(${this._depositWaivedLabel(a.deposit_waived_reason)})</span>` : ''} <span style="float:right">${this.fmt(a.estimated_deposit_total || 0)}</span></div>
              ${a.delivery_required ? `<div>Delivery Fee <span style="float:right">${this.fmt(a.delivery_cost)}</span></div>` : ''}
              ${a.pickup_required ? `<div>Pickup Fee <span style="float:right">${this.fmt(a.pickup_cost)}</span></div>` : ''}
              ${a.operator_required ? `<div>Operator Fee <span style="float:right">${this.fmt(a.operator_fee)}</span></div>` : ''}
              ${a.estimated_discount > 0 ? `<div style="color:var(--success)">Quote Discount <span style="float:right">-${this.fmt(a.estimated_discount)}</span></div>` : ''}
            </div>
            <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;font-size:15px;font-weight:600">Grand Total <span style="float:right">${this.fmt(a.estimated_total || 0)}</span></div>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:-6px">Rental fee and deposit are estimated as of now and will be finalized at the moment you click Complete Checkout.</p>
          <div class="form-group"><label>Payment Method</label>
            <select id="rf-paymethod" onchange="App._toggleRentalPOFields()">
              <option value="cash">Cash</option>
              <option value="credit_card">Credit Card</option>
              <option value="debit_card">Debit Card</option>
              <option value="check">Check</option>
              <option value="tax_exempt_tender">Tax Exempt</option>
              <option value="direct_deposit">Direct Deposit</option>
              <option value="credit">Charge Account (Credit)</option>
              <option value="split">Split Tender (Multiple Methods)</option>
            </select>
          </div>
          <div class="form-group" id="rf-tendered-group" style="display:none">
            <label>Amount Tendered</label>
            <input type="number" id="rf-tendered" step="any" placeholder="${(a.estimated_total || 0).toFixed(2)}" oninput="App._updateRentalTenderChange()" style="font-size:16px;font-weight:600">
          </div>
          <div id="rf-change-info" style="display:none;font-size:13px;font-weight:600;text-align:right;margin:-6px 0 8px"></div>
          <div id="rf-po-block" style="display:none;border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:4px">
            <div id="rf-po-heading" style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Customer PO — required for credit account rentals</div>
            <div class="form-group" style="margin-bottom:8px"><label style="font-size:11px">PO Number</label><input id="rf-po-number" placeholder="Customer's purchase order #" value="${a.customer_po_number || ''}"></div>
            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:11px">PO Document</label>
              <input type="file" id="rf-po-file" accept="application/pdf,image/*" onchange="App.uploadRentalPO(${id},this)">
              <div id="rf-po-status" style="font-size:11px;color:${this._rfPoAttachmentName?'var(--success)':'var(--text-muted)'};margin-top:4px">${this._rfPoAttachmentName ? `Uploaded: ${this._rfPoAttachmentName} ✓` : 'No document uploaded yet'}</div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="rf-complete-btn" onclick="App.finalizeRentalCheckout(${id})">Complete Checkout</button>
        </div>
      </div>`);
    this._toggleRentalPOFields();
  },

  _toggleRentalPOFields() {
    const method = document.getElementById('rf-paymethod')?.value;
    const block = document.getElementById('rf-po-block');
    // Any rental can carry the customer's P.O. (printed on its invoices); a
    // credit account rental must.
    if (block) block.style.display = 'block';
    const poHeading = document.getElementById('rf-po-heading');
    if (poHeading) poHeading.textContent = method === 'credit' ? 'Customer PO — required for credit account rentals' : 'Customer PO (optional)';
    // Amount Tendered only makes sense for tender types actually handed
    // over at the counter — card settles for the exact total, credit isn't
    // tendered at all.
    const showTender = method === 'cash' || method === 'check';
    const tenderGroup = document.getElementById('rf-tendered-group');
    if (tenderGroup) tenderGroup.style.display = showTender ? 'block' : 'none';
    const infoEl = document.getElementById('rf-change-info');
    if (!showTender && infoEl) infoEl.style.display = 'none';
    this._updateRentalTenderChange();
  },

  _updateRentalTenderChange() {
    const infoEl = document.getElementById('rf-change-info');
    const tenderGroup = document.getElementById('rf-tendered-group');
    const tenderedEl = document.getElementById('rf-tendered');
    if (!infoEl || !tenderedEl || !tenderGroup) return;
    if (tenderGroup.style.display === 'none') { infoEl.style.display = 'none'; return; }
    const tendered = parseFloat(tenderedEl.value);
    const total = this._rfEstimatedTotal || 0;
    if (isNaN(tendered) || tendered <= 0) { infoEl.style.display = 'none'; return; }
    const change = parseFloat((tendered - total).toFixed(2));
    infoEl.style.display = 'block';
    if (change >= 0) {
      infoEl.style.color = 'var(--success)';
      infoEl.textContent = `Change Due: ${this.fmt(change)}`;
    } else {
      infoEl.style.color = 'var(--danger)';
      infoEl.textContent = `Short ${this.fmt(Math.abs(change))}`;
    }
  },

  async uploadRentalPO(agreementId, input) {
    const file = input.files[0];
    if (!file) return;
    const statusEl = document.getElementById('rf-po-status');
    if (statusEl) { statusEl.textContent = 'Uploading…'; statusEl.style.color = 'var(--text-muted)'; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`/api/rentals/agreements/${agreementId}/po-attachment`, { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      this._rfPoAttachmentPath = json.customer_po_attachment_path;
      this._rfPoAttachmentName = json.customer_po_attachment_name;
      if (statusEl) { statusEl.textContent = `Uploaded: ${json.customer_po_attachment_name} ✓`; statusEl.style.color = 'var(--success)'; }
    } catch(e) {
      this._rfPoAttachmentPath = null;
      if (statusEl) { statusEl.textContent = e.message; statusEl.style.color = 'var(--danger)'; }
    }
  },

  async finalizeRentalCheckout(id) {
    const payment_method = document.getElementById('rf-paymethod').value;
    const customer_po_number = document.getElementById('rf-po-number')?.value.trim() || null;
    if (payment_method === 'credit') {
      if (!customer_po_number) { this.alert('A customer PO number is required for credit account rentals', 'error'); return; }
      if (!this._rfPoAttachmentPath) { this.alert('The customer PO document must be attached before completing this checkout', 'error'); return; }
    }
    // Amount Tendered is only collected for cash/check (see
    // _toggleRentalPOFields) — the estimated total is what's on screen when
    // the cashier types it in; the real total (computed fresh at the moment
    // checkout posts, per feeFor in routes/rentals.js) may drift by a few
    // seconds' worth of rental fee, so this is a UX guard, not authoritative.
    let amount_tendered = null;
    // Split tender replaces this modal with the shared split modal (it clears
    // any open overlay), so cancelling there reopens this checkout.
    let tenders = null, splitForeignCash = null;
    if (payment_method === 'split') {
      const split = await this.showSplitTenderModal(this._rfEstimatedTotal, { exclude: ['gift_card'] });
      if (!split) { this.showFinalizeRentalModal(id); return; }
      tenders = split.tenders;
      splitForeignCash = split.foreignCash;
    }
    if (payment_method === 'cash' || payment_method === 'check') {
      const tenderedRaw = document.getElementById('rf-tendered')?.value;
      amount_tendered = tenderedRaw ? parseFloat(tenderedRaw) : this._rfEstimatedTotal;
      if (isNaN(amount_tendered) || amount_tendered < this._rfEstimatedTotal - 0.01) {
        this.alert('Amount tendered is less than the total due', 'error');
        return;
      }
    }
    // Without this guard a fast double-click (or a slow response tempting a
    // second tap) fires two overlapping PATCH requests — the first commits
    // the checkout, the second then fails (agreement no longer 'pending',
    // and/or a colliding transaction_number) and flashes a raw error toast
    // even though the rental already went through.
    const btn = document.getElementById('rf-complete-btn');
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Processing…';
    }
    try {
      const agreement = await this.api('PATCH', `/rentals/agreements/${id}/checkout`, {
        payment_method,
        employee_id: this.currentUser.id,
        drawer_session_id: this.currentDrawerSession?.id || null,
        customer_po_number,
        amount_tendered,
        tenders,
      });
      this.closeModal();
      this.alert(`Rental ${agreement.agreement_number} checked out`);
      this.renderRentals();
      this.updateHoldBadge();
      // The checkout transaction (rental fee + deposit + delivery/pickup/
      // operator fees, all itemized) is what showReceipt/printReceiptLetter
      // renders as the letter-size RENTAL AGREEMENT — same receipt flow a
      // normal POS sale gets, just reached from the rental checkout path
      // instead of the cart.
      if (agreement.checkout_transaction_id) {
        const tx = await this.api('GET', `/transactions/${agreement.checkout_transaction_id}`);
        this.showReceipt(tx, tx.change_amount || 0, null, splitForeignCash);
      }
    } catch(e) {
      this.alert(e.message, 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Complete Checkout';
      } else if (tenders) {
        this.showFinalizeRentalModal(id);
      }
    }
  },

  async showIssueRentalModal(id) {
    const [a, employees] = await Promise.all([
      this.api('GET', `/rentals/agreements/${id}`),
      this.api('GET', '/employees'),
    ]);
    if (a.status !== 'awaiting_issue') { this.alert('This rental is not awaiting issue', 'warning'); return; }
    const drivers = employees.filter(e => e.is_driver);
    const operators = employees.filter(e => e.is_operator);
    const securityEmployees = employees.filter(e => e.is_security);
    const nowLocal = new Date();
    const defaultIssuedAt = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth()+1).padStart(2,'0')}-${String(nowLocal.getDate()).padStart(2,'0')}T${String(nowLocal.getHours()).padStart(2,'0')}:${String(nowLocal.getMinutes()).padStart(2,'0')}`;
    this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header">
          <span class="modal-title">Issue Rental — ${a.agreement_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row" style="margin-bottom:10px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Customer</label><div>${a.customer_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Due Date</label><div>${this.fmtDate(a.due_date)}</div></div>
          </div>
          <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:12px">
            ${a.items.filter(i=>!i.parent_item_id).map(i => {
              const accs = a.items.filter(x => x.parent_item_id === i.id);
              return `<div style="font-size:13px;margin-bottom:4px"><strong>${i.product_name}</strong> × ${i.quantity}
                ${accs.length ? `<div style="font-size:11px;color:var(--text-muted)">+ ${accs.map(x=>x.product_name).join(', ')}</div>` : ''}</div>`;
            }).join('')}
          </div>
          <div class="form-group" style="margin-bottom:12px">
            <label>Start Date / Time</label>
            <input type="datetime-local" id="ri-issued-at" value="${defaultIssuedAt}" max="${defaultIssuedAt}">
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Defaults to now — back-date this if the item actually went out earlier. The rental clock and all fee calculations run from this time.</div>
          </div>

          ${a.delivery_required ? (a.delivery_driver_confirmed_at
            ? `<div style="padding:8px 12px;background:rgba(22,163,74,0.08);border-left:3px solid #16a34a;border-radius:4px;font-size:12px;color:#166534;margin-bottom:12px">✓ ${a.delivery_driver_name||'A driver'} has already claimed and signed for this delivery on ${this.fmtDateTime(a.delivery_driver_confirmed_at)}${this._sigButton(a.delivery_driver_signature, 'View Driver Signature')}</div>`
            : `<div class="form-group">
            <label>Delivery Driver <span style="font-weight:400;color:var(--text-muted)">(fee ${this.fmt(a.delivery_cost)}, already charged)</span></label>
            <select id="ri-delivery-driver">
              <option value="">-- Select --</option>
              ${drivers.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
            ${!drivers.length ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">No employees are flagged as a driver yet.</div>` : ''}
          </div>`) : ''}

          ${a.operator_required ? `<div class="form-group">
            <label>Operator <span style="font-weight:400;color:var(--text-muted)">(fee ${this.fmt(a.operator_fee)}, already charged)</span></label>
            <select id="ri-operator-id">
              <option value="">-- Select --</option>
              ${operators.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
            ${!operators.length ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">No employees are flagged as an operator yet.</div>` : ''}
          </div>` : ''}

          <div style="border-top:1px solid var(--border);padding-top:12px">
          ${a.issue_security_employee_id
            ? `<div style="padding:8px 12px;background:rgba(22,163,74,0.08);border-left:3px solid #16a34a;border-radius:4px;font-size:12px;color:#166534;margin-bottom:12px">✓ ${a.issue_security_employee_name||'Security'} already signed off on ${this.fmtDateTime(a.issue_security_confirmed_at)}${this._sigButton(a.issue_security_signature, 'View Guard Signature')}</div>`
            : `<div class="form-group" style="margin-bottom:12px">
            <label>Security Verification <span style="font-weight:400;color:var(--text-muted)">(required — item leaving the premises)</span></label>
            <select id="ri-security-employee">
              <option value="">-- Select --</option>
              ${securityEmployees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
            ${!securityEmployees.length ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">No employees are flagged as Security yet — this rental can't be issued until one is (Employees → edit → Security checkbox).</div>` : ''}
          </div>
          ${this._sigPadHtml('ri-guard-sig', 'Guard Signature', 'required — the security employee above signs to confirm')}`}
          </div>
          ${this._sigPadHtml('ri-customer-sig', 'Customer Signature', 'required — confirms receipt')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.confirmIssueRental(${id})">Issue Rental</button>
        </div>
      </div>`);
    this._sigPadInit('ri-guard-sig');
    this._sigPadInit('ri-customer-sig');
  },

  async confirmIssueRental(id) {
    const deliveryDriverEl = document.getElementById('ri-delivery-driver');
    const operatorEl = document.getElementById('ri-operator-id');
    const securityEl = document.getElementById('ri-security-employee');
    // The security dropdown/pad only exist when security hasn't already
    // signed off (see showIssueRentalModal's banner-vs-form branch) — nothing
    // to validate or send if they're not on the page.
    const hasSecuritySigPad = !!document.getElementById('ri-guard-sig');
    if (deliveryDriverEl && !deliveryDriverEl.value) { this.alert('Select a driver for delivery', 'error'); return; }
    if (operatorEl && !operatorEl.value) { this.alert('Select an operator', 'error'); return; }
    if (securityEl && !securityEl.value) { this.alert('Select the security employee who verified this item leaving', 'error'); return; }
    if (hasSecuritySigPad && !this._sigPadHasDrawn('ri-guard-sig')) { this.alert("The security employee's signature is required to issue this rental", 'error'); return; }
    if (!this._sigPadHasDrawn('ri-customer-sig')) { this.alert('Customer signature is required to issue this rental', 'error'); return; }
    const issuedAtRaw = document.getElementById('ri-issued-at')?.value;
    if (!issuedAtRaw) { this.alert('Enter a start date/time', 'error'); return; }
    // The datetime-local input has no timezone of its own — new Date() here
    // resolves it against the browser's local clock, then toISOString() makes
    // it unambiguous for the server regardless of what timezone it runs in.
    const issuedAt = new Date(issuedAtRaw).toISOString();
    try {
      const agreement = await this.api('PATCH', `/rentals/agreements/${id}/issue`, {
        employee_id: this.currentUser?.id || null,
        delivery_driver_id: deliveryDriverEl ? parseInt(deliveryDriverEl.value) || null : null,
        operator_id: operatorEl ? parseInt(operatorEl.value) || null : null,
        issued_at: issuedAt,
        security_employee_id: securityEl ? parseInt(securityEl.value) : null,
        security_signature: hasSecuritySigPad ? this._sigPadDataUrl('ri-guard-sig') : null,
        customer_signature: this._sigPadDataUrl('ri-customer-sig'),
      });
      this.closeModal();
      this.alert(`Rental ${agreement.agreement_number} issued — clock started`);
      if (this.section === 'rental-dispatch') this.loadDispatchTab();
      else this.renderRentals();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // "Due Sun Oct 18 (closed) — may come back by 8:00 AM Tue Oct 20 at no
  // extra charge" — set by GET /rentals/agreements(/:id) for an active rental
  // due on a closed day at a branch with closed_day_grace (lib/closedDays.js).
  // Shown in store time (the date and time as set), whatever the viewer's
  // own clock is set to.
  _closedDayReturnBy(g, { long = true } = {}) {
    const [h, m] = String(g.returnBy || '08:00').split(':').map(Number);
    const time = `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
    const day = new Date(`${g.nextOpenDate}T00:00:00Z`).toLocaleDateString('en-US', long ? { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', timeZone: 'UTC' });
    return `${time} ${day}`;
  },

  _closedDayGraceNote(a) {
    const g = a.closed_day_grace;
    if (!g) return '';
    return `Due on a closed day (${g.closedReason}) — may be returned by ${this._closedDayReturnBy(g)} with no late charge`;
  },

  async showRentalReturnModal(id) {
    const [a, employees] = await Promise.all([
      this.api('GET', `/rentals/agreements/${id}`),
      this.api('GET', '/employees'),
    ]);
    const outstanding = a.items.filter(i => i.quantity_returned < i.quantity);
    if (!outstanding.length) { this.alert('All items on this agreement are already returned', 'warning'); return; }
    const drivers = employees.filter(e => e.is_driver);
    const securityEmployees = employees.filter(e => e.is_security);
    const nowLocal = new Date();
    const defaultReturnedAt = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth()+1).padStart(2,'0')}-${String(nowLocal.getDate()).padStart(2,'0')}T${String(nowLocal.getHours()).padStart(2,'0')}:${String(nowLocal.getMinutes()).padStart(2,'0')}`;
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header">
          <span class="modal-title">Process Return — ${a.agreement_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">All outstanding items must be included in this return.</p>
          <div class="form-group" style="margin-bottom:12px">
            <label>Return Date / Time</label>
            <input type="datetime-local" id="rr-returned-at" value="${defaultReturnedAt}" max="${defaultReturnedAt}">
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Defaults to now — back-date this to when the item actually came back if it sat before being processed. Fees are calculated against this time.</div>
          </div>
          ${a.closed_day_grace ? `<div style="padding:8px 12px;background:rgba(0,126,55,0.08);border-left:3px solid var(--primary);border-radius:4px;font-size:12px;margin-bottom:12px">${this._closedDayGraceNote(a)}.</div>` : ''}
          ${a.checkout_payment_method === 'credit' ? `<div style="padding:8px 12px;background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;border-radius:4px;font-size:12px;color:#3b82f6;margin-bottom:12px">This rental was charged to the customer's account. The settlement (duration adjustment, damage fees, and deposit) will be applied directly to their account balance — no cash/card is collected here.</div>` : ''}
          ${outstanding.map(i => {
            const remaining = i.quantity - i.quantity_returned;
            const tag = i.parent_item_id ? (i.is_mandatory ? ' <span class="badge-pill badge-success" style="font-size:10px">included, no charge</span>' : ' <span class="badge-pill badge-secondary" style="font-size:10px">accessory</span>') : '';
            return `<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">
              <div class="fw-600" style="margin-bottom:6px">${i.product_name}${tag} <span style="font-weight:400;color:var(--text-muted);font-size:12px">(${remaining} outstanding)</span></div>
              <div class="input-row">
                <div class="form-group"><label style="font-size:11px">Qty Returned</label><input type="number" id="rr-qty-${i.id}" value="${remaining}" min="0" max="${remaining}"></div>
                <div class="form-group"><label style="font-size:11px">Damage Fee</label><input type="number" id="rr-fee-${i.id}" value="0" min="0" step="0.01"></div>
              </div>
              <div class="input-row">
                <div class="form-group"><label style="font-size:11px">Condition In</label><input id="rr-cond-${i.id}" placeholder="e.g. Good condition"></div>
                <div class="form-group"><label style="font-size:11px">Damage Notes</label><input id="rr-notes-${i.id}" placeholder="Optional"></div>
              </div>
            </div>`;
          }).join('')}
          ${a.pickup_required ? `<div class="form-group">
            <label>Pickup Driver <span style="font-weight:400;color:var(--text-muted)">(fee ${this.fmt(a.pickup_cost)}, already charged)</span></label>
            <select id="rr-pickup-driver" ${a.pickup_confirmed_at ? 'disabled' : ''}>
              <option value="">-- Select --</option>
              ${drivers.map(e => `<option value="${e.id}" ${a.pickup_driver_id===e.id?'selected':''}>${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
            ${!drivers.length ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">No employees are flagged as a driver yet.</div>` : ''}
          </div>
          ${a.pickup_confirmed_at
            ? `<div style="padding:8px 12px;background:rgba(22,163,74,0.08);border-left:3px solid #16a34a;border-radius:4px;font-size:12px;color:#166534;margin-bottom:12px">✓ Pickup already confirmed in the field by ${a.pickup_driver_name||'the driver'} on ${this.fmtDateTime(a.pickup_confirmed_at)}${a.pickup_customer_name ? ` — signed by ${a.pickup_customer_name}` : ''}${this._sigButton(a.pickup_customer_signature, 'View Customer Signature')}</div>`
            : this._sigPadHtml('rr-driver-sig', 'Driver Signature', 'required — the driver above signs to confirm collection')}` : ''}

          <div class="form-group" style="border-top:1px solid var(--border);padding-top:12px">
            <label>Security Sign-In <span style="font-weight:400;color:var(--text-muted)">(required — item returning)</span></label>
            <select id="rr-security-employee">
              <option value="">-- Select --</option>
              ${securityEmployees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
            ${!securityEmployees.length ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">No employees are flagged as Security yet.</div>` : ''}
          </div>
          ${this._sigPadHtml('rr-guard-sig', 'Guard Signature', 'required — the security employee above signs to confirm')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveRentalReturn(${id}, [${outstanding.map(i=>i.id).join(',')}])">Confirm Return</button>
        </div>
      </div>`);
    this._sigPadInit('rr-guard-sig');
    if (a.pickup_required && !a.pickup_confirmed_at) this._sigPadInit('rr-driver-sig');
  },

  async saveRentalReturn(agreementId, itemIds) {
    const items = itemIds.map(id => ({
      item_id: id,
      quantity_returned: parseInt(document.getElementById(`rr-qty-${id}`)?.value) || 0,
      damage_fee: parseFloat(document.getElementById(`rr-fee-${id}`)?.value) || 0,
      condition_in: document.getElementById(`rr-cond-${id}`)?.value.trim() || null,
      damage_notes: document.getElementById(`rr-notes-${id}`)?.value.trim() || null,
    })).filter(i => i.quantity_returned > 0);
    if (!items.length) { this.alert('Enter at least one returned quantity', 'error'); return; }
    const pickupDriverEl = document.getElementById('rr-pickup-driver');
    // The driver signature pad only exists when the pickup wasn't already
    // confirmed in the field (see showRentalReturnModal) — nothing to check
    // if it's not on the page.
    const hasDriverSigPad = !!document.getElementById('rr-driver-sig');
    if (pickupDriverEl) {
      if (!pickupDriverEl.value) { this.alert('Select a driver for pickup', 'error'); return; }
      if (hasDriverSigPad && !this._sigPadHasDrawn('rr-driver-sig')) { this.alert("The driver's signature is required to complete this pickup return", 'error'); return; }
    }
    const securityEl = document.getElementById('rr-security-employee');
    if (!securityEl?.value) { this.alert('Select the security employee signing this item back in', 'error'); return; }
    if (!this._sigPadHasDrawn('rr-guard-sig')) { this.alert("The security employee's signature is required to complete this return", 'error'); return; }
    const returnedAtRaw = document.getElementById('rr-returned-at').value;
    if (!returnedAtRaw) { this.alert('Enter a return date/time', 'error'); return; }
    // The datetime-local input has no timezone of its own — new Date() here
    // resolves it against the browser's local clock, then toISOString() makes
    // it unambiguous for the server regardless of what timezone it runs in.
    const returnedAt = new Date(returnedAtRaw).toISOString();
    try {
      const updated = await this.api('PATCH', `/rentals/agreements/${agreementId}/return`, {
        items,
        drawer_session_id: this.currentDrawerSession?.id || null,
        pickup_driver_id: pickupDriverEl ? parseInt(pickupDriverEl.value) || null : null,
        returned_at: returnedAt,
        return_security_employee_id: parseInt(securityEl.value),
        return_driver_employee_id: pickupDriverEl ? parseInt(pickupDriverEl.value) || null : null,
        security_signature: this._sigPadDataUrl('rr-guard-sig'),
        driver_signature: hasDriverSigPad ? this._sigPadDataUrl('rr-driver-sig') : null,
      });
      this.closeModal();
      if (updated.closed_day_grace_applied) this.alert(`Returned within the closed-day grace period (${updated.closed_day_grace_applied.closedReason}) — no late charge for the time after it was due.`, 'success');
      if (updated.settlement_transaction_id) {
        const tx = await this.api('GET', `/transactions/${updated.settlement_transaction_id}`);
        this.showReceipt(tx, tx.change_amount || 0);
      } else {
        const balanceDue = (updated.damage_fee_total || 0) + (updated.duration_adjustment_total || 0) - (updated.deposit_total || 0) + (updated.tax_adjustment_total || 0) + (updated.service_adjustment_total || 0);
        if (balanceDue > 0) {
          this.alert(`Item signed in. Balance of ${this.fmt(balanceDue)} is due — send the customer to the register to complete payment. Until it's paid, this rental is listed under Returned – Not Paid and the customer can't start a new rental.`, 'success');
        } else {
          this.alert('Return processed');
        }
      }
      this.renderRentals();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // A rental returned with a balance owed shows up in POS Hold Recall
  // (view=awaiting_payment) rather than being settled by whoever processed
  // the physical return — same cash-with-the-cashier pattern as
  // showWOFinalPaymentModal below.
  async showRentalBalanceDueModal(id) {
    try {
      const a = await this.api('GET', `/rentals/agreements/${id}`);
      const balance = parseFloat(((a.damage_fee_total||0) + (a.duration_adjustment_total||0) - (a.deposit_total||0) + (a.tax_adjustment_total||0) + (a.service_adjustment_total||0)).toFixed(2));
      this.showModal(`
        <div class="modal" style="max-width:440px">
          <div class="modal-header"><span class="modal-title">Collect Rental Balance — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
          <div class="modal-body">
            <div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:13px">
              <div style="display:flex;justify-content:space-between"><span>Customer</span><span>${a.customer_name || '—'}</span></div>
              <div style="display:flex;justify-content:space-between"><span>Damage fees</span><span>${this.fmt(a.damage_fee_total)}</span></div>
              <div style="display:flex;justify-content:space-between"><span>Duration adjustment</span><span>${this.fmt(a.duration_adjustment_total)}</span></div>
              <div style="display:flex;justify-content:space-between"><span>Tax adjustment</span><span>${this.fmt(a.tax_adjustment_total)}</span></div>
              ${a.service_adjustment_total ? `<div style="display:flex;justify-content:space-between"><span>${a.service_adjustment_total > 0 ? 'Pickup fee (added after checkout)' : 'Pickup fee credit'}</span><span>${this.fmt(a.service_adjustment_total)}</span></div>` : ''}
              <div style="display:flex;justify-content:space-between"><span>Less deposit</span><span>-${this.fmt(a.deposit_total)}</span></div>
              <div style="display:flex;justify-content:space-between;margin-top:4px;border-top:1px solid var(--border);padding-top:4px"><strong>Balance Due</strong><strong>${this.fmt(balance)}</strong></div>
            </div>
            <div class="form-group"><label>Payment Method</label>
              <select id="rb-paymethod" onchange="App._toggleRentalBalanceTenderFields()">
                <option value="cash">Cash</option>
                <option value="credit_card">Credit Card</option>
                <option value="debit_card">Debit Card</option>
                <option value="check">Check</option>
                <option value="tax_exempt_tender">Tax Exempt</option>
                <option value="gift_card">Gift Card</option>
                <option value="direct_deposit">Direct Deposit</option>
                <option value="split">Split Tender (Multiple Methods)</option>
              </select>
            </div>
            <div class="form-group" id="rb-tendered-group" style="display:none">
              <label>Amount Tendered</label>
              <input type="number" id="rb-tendered" step="any" placeholder="${balance.toFixed(2)}" oninput="App._updateRentalBalanceTenderChange(${balance})" style="font-size:16px;font-weight:600">
            </div>
            <div id="rb-change-info" style="display:none;font-size:13px;font-weight:600;text-align:right"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="App.confirmRentalBalancePayment(${id}, ${balance})">Confirm Payment</button>
          </div>
        </div>`);
      this._toggleRentalBalanceTenderFields();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  _toggleRentalBalanceTenderFields() {
    const method = document.getElementById('rb-paymethod')?.value;
    const showTender = method === 'cash' || method === 'check';
    const tenderGroup = document.getElementById('rb-tendered-group');
    if (tenderGroup) tenderGroup.style.display = showTender ? 'block' : 'none';
    const infoEl = document.getElementById('rb-change-info');
    if (!showTender && infoEl) infoEl.style.display = 'none';
  },

  _updateRentalBalanceTenderChange(balance) {
    const infoEl = document.getElementById('rb-change-info');
    const tenderedEl = document.getElementById('rb-tendered');
    if (!infoEl || !tenderedEl) return;
    const tendered = parseFloat(tenderedEl.value);
    if (isNaN(tendered) || tendered <= 0) { infoEl.style.display = 'none'; return; }
    const change = parseFloat((tendered - balance).toFixed(2));
    infoEl.style.display = 'block';
    if (change >= 0) {
      infoEl.style.color = 'var(--success)';
      infoEl.textContent = `Change Due: ${this.fmt(change)}`;
    } else {
      infoEl.style.color = 'var(--danger)';
      infoEl.textContent = `Short ${this.fmt(Math.abs(change))}`;
    }
  },

  async confirmRentalBalancePayment(id, balance) {
    const payment_method = document.getElementById('rb-paymethod')?.value;
    const amount_tendered = document.getElementById('rb-tendered')?.value || undefined;
    // Same pattern as finalizeRentalCheckout: the split modal replaces this
    // one, so cancelling (or a failed post) reopens the balance modal.
    let tenders = null, splitForeignCash = null;
    if (payment_method === 'split') {
      const split = await this.showSplitTenderModal(balance);
      if (!split) { this.showRentalBalanceDueModal(id); return; }
      tenders = split.tenders;
      splitForeignCash = split.foreignCash;
    }
    try {
      const settled = await this.api('PATCH', `/rentals/agreements/${id}/collect-balance`, {
        payment_method, amount_tendered, tenders, employee_id: this.currentUser.id, drawer_session_id: this.currentDrawerSession?.id || null,
      });
      this.closeModal();
      const tx = await this.api('GET', `/transactions/${settled.id}`);
      this.showReceipt(tx, tx.change_amount || 0, null, splitForeignCash);
      this.updateHoldBadge();
      if (this.section === 'rentals') this.renderRentals();
    } catch(e) {
      this.alert(e.message, 'error');
      if (tenders) this.showRentalBalanceDueModal(id);
    }
  },

});
