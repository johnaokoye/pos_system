// Driver / guard landing dashboards, pickup and delivery field flows, main dashboard.
Object.assign(App, {
  // ─── Dashboard ────────────────────────────────────────────
  // ─── Driver / Guard landing dashboards ─────────────────────────────────
  // Shown instead of the generic (manager-oriented) Dashboard for employees
  // flagged is_driver/is_security (see enterApp()'s landing-priority
  // check) — read entirely from the existing GET /rentals/agreements
  // endpoint, no new backend routes for delivery/issue-time security (those
  // fields are only set AS the Issue/Return action itself is completed, not
  // booked ahead of time). Pickup is the one exception: a dispatcher can
  // pre-assign pickup_driver_id (PATCH .../assign-pickup-driver, from the
  // Rental Dispatch / agreement-detail "Assign Driver" action), so "Pickups
  // Needed" below is filtered to jobs assigned to THIS driver and not yet
  // confirmed. The Confirm Pickup button itself only renders for a security
  // group with rentals_confirm_pickup — so an employee can be flagged
  // is_driver (to land on this dashboard and see what's assigned) without
  // necessarily being able to act on it, same as any other sub-permission.
  // Deliveries/security are still the shared pending pool they always were.
  // Where the item currently sits — the delivery override address if one
  // was set at hold-creation time, otherwise the customer's address on
  // file. Same field a delivery driver dropped it off at, so it's also
  // where a pickup driver needs to go collect it back from. Shared with
  // loadDeliveriesTab's own toAddr (kept as a local alias there).
  _rentalPickupAddress(a) {
    // pickup_address is always entered for new rentals; older ones fall back.
    return a.pickup_address || a.delivery_address || [a.customer_address, [a.customer_city, a.customer_state, a.customer_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
  },

  // showAgreementLink=false for the driver's own "My Recent Activity" (see
  // renderDriverDashboard) — a driver can see the delivery/pickup address
  // for a job but must not be able to open the full rental agreement (rate/
  // deposit/payment detail), which is exactly what App.viewRentalAgreement
  // renders. Guard's "My Recent Verifications" keeps the link since guards
  // already hold rentals_security_signoff on the agreement they signed off.
  _rentalDashRow(a, extra = '', actionHtml = '', addressHtml = '', showAgreementLink = true) {
    const overdue = a.display_status === 'overdue';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div class="fw-600">${a.agreement_number} <span style="font-weight:400;color:var(--text-muted)">— ${a.customer_name||'—'}</span></div>
        <div style="font-size:12px;color:var(--text-muted)">${a.item_summary||''}</div>
        ${addressHtml}
      </div>
      <div style="text-align:right">
        <div style="font-size:12px;${overdue?'color:var(--danger);font-weight:600':'color:var(--text-muted)'}">${overdue?'Overdue — ':''}Due ${this.fmtDate(a.due_date)}</div>
        ${extra}
        <div style="margin-top:4px;display:flex;gap:6px;justify-content:flex-end">
          ${actionHtml}
          ${showAgreementLink ? `<button class="btn btn-sm btn-outline" onclick="App.viewRentalAgreement(${a.id})">View</button>` : ''}
        </div>
      </div>
    </div>`;
  },

  _rentalDashSection(title, rows, emptyMsg) {
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-header"><span class="card-title">${title}</span></div>
      ${rows.length ? rows.join('') : `<p style="color:var(--text-muted);margin:0;padding:8px 0">${emptyMsg}</p>`}
    </div>`;
  },

  // Address + phone block shown on delivery rows — deliberately the only
  // customer info beyond name shown to a driver (see GET
  // /rentals/agreements/driver-queue, which is the restricted, non-financial
  // projection this whole dashboard reads from).
  _rentalDeliveryContactHtml(a) {
    return `<div style="font-size:12px;color:var(--text-muted)">📍 ${this._rentalPickupAddress(a) || 'No address on file'}</div>
      ${a.customer_phone ? `<div style="font-size:12px;color:var(--text-muted)">📞 ${a.customer_phone}</div>` : ''}`;
  },

  async renderDriverDashboard() {
    const agreements = await this.api('GET', '/rentals/agreements/driver-queue');
    if (this.section !== 'driver-dashboard') return;
    // Cached for the claim/signature modals below, so they can read the
    // restricted row data already in hand instead of a fresh fetch — the
    // full GET /rentals/agreements/:id route requires the broad `rentals`
    // permission and returns every financial column, which is exactly what
    // this dashboard is built to avoid exposing to a driver.
    this._driverQueueCache = agreements;

    const myId = this.currentUser.id;
    // Security must have signed off (issue_security_employee_id set) before
    // a delivery is even visible to drivers — see PATCH .../security-signoff.
    // First-come-first-served: unclaimed, or already claimed by me (in case
    // I refresh mid-claim).
    const readyToClaim = agreements.filter(a => a.delivery_required && a.status === 'awaiting_issue' && a.issue_security_employee_id && !a.delivery_driver_confirmed_at && (!a.delivery_driver_id || a.delivery_driver_id === myId));
    const outForDelivery = agreements.filter(a => a.delivery_required && a.status === 'awaiting_issue' && a.delivery_driver_confirmed_at && a.delivery_driver_id === myId);
    // Only jobs dispatch has actually assigned to THIS driver (see
    // assign-pickup-driver) and not yet confirmed in the field — not the
    // shared pending pool above still is.
    const pickups = agreements.filter(a => a.pickup_required && a.status === 'active' && a.pickup_driver_id === myId && !a.pickup_confirmed_at)
      .sort((a,b) => (a.pickup_scheduled_start || a.due_date || '').localeCompare(b.pickup_scheduled_start || b.due_date || ''));
    readyToClaim.sort((a,b) => (a.delivery_scheduled_start || '9').localeCompare(b.delivery_scheduled_start || '9'));
    // When dispatch has booked the job: "🗓 Fri 9:00 AM – 11:00 AM" + notes.
    const booked = (a, leg) => {
      const s = a[`${leg}_scheduled_start`]; if (!s) return '';
      const e = a[`${leg}_scheduled_end`];
      const t = d => this._toDate(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: this._storeTz() });
      return `<div style="font-size:12px;font-weight:600;color:var(--primary)">🗓 ${t(s)}${e ? ` – ${this._toDate(e).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: this._storeTz() })}` : ''}</div>${a[`${leg}_schedule_notes`] ? `<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(a[`${leg}_schedule_notes`])}</div>` : ''}`;
    };

    const history = agreements
      .filter(a => (a.delivery_driver_id === myId && a.delivery_driver_confirmed_at) || (a.pickup_driver_id === myId && (a.pickup_confirmed_at || a.status === 'returned')) || a.return_driver_employee_id === myId)
      .map(a => ({ a, at: a.returned_at || a.pickup_confirmed_at || a.delivery_driver_confirmed_at || a.checkout_datetime || a.created_at }))
      .sort((x,y) => (y.at||'').localeCompare(x.at||''))
      .slice(0, 8)
      .map(x => x.a);

    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>My Deliveries</h2></div>
      ${this._rentalDashSection('Deliveries Ready to Claim', readyToClaim.map(a => this._rentalDashRow(a, booked(a, 'delivery'), this.can('rentals_confirm_delivery') ? `<button class="btn btn-sm btn-primary" onclick="App.showClaimDeliveryModal(${a.id})">Accept &amp; Sign for Delivery</button>` : '', this._rentalDeliveryContactHtml(a))), 'No deliveries waiting to go out.')}
      ${this._rentalDashSection('Out for Delivery — Awaiting Customer Signature', outForDelivery.map(a => this._rentalDashRow(a, booked(a, 'delivery'), this.can('rentals_confirm_delivery') ? `<button class="btn btn-sm btn-primary" onclick="App.showDeliveryCustomerSignatureModal(${a.id})">Get Customer Signature</button>` : '', this._rentalDeliveryContactHtml(a))), 'Nothing out for delivery right now.')}
      ${this._rentalDashSection('Pickups Needed', pickups.map(a => this._rentalDashRow(a, booked(a, 'pickup'), this.can('rentals_confirm_pickup') ? `<button class="btn btn-sm btn-primary" onclick="App.showConfirmPickupModal(${a.id})">Confirm Pickup</button>` : '', `<div style="font-size:12px;color:var(--text-muted)">📍 ${this._rentalPickupAddress(a) || 'No address on file'}</div>`)), 'No pickups assigned to you right now.')}
      ${this._rentalDashSection('My Recent Activity', history.map(a => this._rentalDashRow(a, `<div style="font-size:11px;color:var(--text-muted)">${a.display_status}</div>`, '', `<div style="font-size:12px;color:var(--text-muted)">📍 ${this._rentalPickupAddress(a) || 'No address on file'}</div>`, false)), 'No completed deliveries or pickups yet.')}
    `;
  },

  // Add / change / cancel the pickup after the rental was set up — see PATCH
  // /rentals/agreements/:id/pickup-service for how the fee is settled.
  async showChangePickupModal(id) {
    const a = await this.api('GET', `/rentals/agreements/${id}`);
    const has = !!a.pickup_required;
    const paid = !!a.checkout_transaction_id;
    const charged = a.pickup_cost_charged != null ? a.pickup_cost_charged : (has ? a.pickup_cost : 0);
    this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">${has ? 'Change Pickup' : 'Add Pickup'} — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">${paid
            ? `Pickup fee paid at checkout: <strong>${this.fmt(charged || 0)}</strong>. Any difference from the fee below is ${has ? 'added to or credited in' : 'added to'} the return settlement when the item comes back.`
            : 'This rental hasn\'t been paid yet — the fee below is simply what the cashier will charge at checkout.'}</p>
          <div class="form-group" style="max-width:220px"><label>Pickup Fee</label><input type="number" id="cp-cost" min="0" step="0.01" value="${has ? (a.pickup_cost || 0) : 0}" oninput="App._changePickupPreview(${paid ? charged || 0 : 'null'})"></div>
          <div class="form-group"><label>Pickup Address *${a.delivery_address ? ` <a href="#" style="font-weight:400;text-transform:none;color:var(--primary);margin-left:6px" onclick="event.preventDefault();document.getElementById('cp-address').value=${this.escapeAttr(JSON.stringify(a.delivery_address))}">same as delivery address</a>` : ''}</label>
            <textarea id="cp-address" rows="2" placeholder="Required — ask the customer where it's being collected from, even if it's their own address">${this.escapeAttr(has ? (a.pickup_address || '') : '')}</textarea></div>
          <div class="form-group"><label>Reason${has ? ' <span style="font-weight:400;color:var(--text-muted);font-size:11px">(required to cancel)</span>' : ' <span style="font-weight:400;color:var(--text-muted);font-size:11px">(optional)</span>'}</label><input id="cp-reason" placeholder="${has ? 'e.g. Customer will return it themselves' : 'e.g. Customer asked us to collect it'}"></div>
          <div id="cp-preview" style="font-size:12px;font-weight:600"></div>
        </div>
        <div class="modal-footer">
          ${has ? `<button class="btn btn-danger" onclick="App.saveChangePickup(${id},'cancel')">Cancel Pickup</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-primary" onclick="App.saveChangePickup(${id},'${has ? 'update' : 'add'}')">${has ? 'Save Changes' : 'Add Pickup'}</button>
        </div>
      </div>`);
    this._changePickupPreview(paid ? charged || 0 : null);
  },

  _changePickupPreview(charged) {
    const el = document.getElementById('cp-preview');
    if (!el) return;
    if (charged == null) { el.textContent = ''; return; }
    const diff = parseFloat(((parseFloat(document.getElementById('cp-cost')?.value) || 0) - charged).toFixed(2));
    el.style.color = diff ? 'var(--warning,#d97706)' : 'var(--text-muted)';
    el.textContent = diff > 0 ? `${this.fmt(diff)} will be added to the return settlement` : diff < 0 ? `${this.fmt(-diff)} will be credited in the return settlement` : 'No change to what was charged';
  },

  async saveChangePickup(id, action) {
    const body = { action, employee_id: this.currentUser.id, reason: document.getElementById('cp-reason')?.value.trim() || null };
    if (action === 'cancel') {
      if (!body.reason) { this.alert('Give a reason for cancelling the pickup', 'error'); document.getElementById('cp-reason')?.focus(); return; }
      if (!confirm('Cancel the pickup? The customer will need to bring the item back themselves.')) return;
    } else {
      body.pickup_cost = document.getElementById('cp-cost').value;
      body.pickup_address = document.getElementById('cp-address').value.trim();
      if (!body.pickup_address) { this.alert("Enter the pickup address — ask the customer where it's being collected from, even if it's their own address", 'error'); document.getElementById('cp-address')?.focus(); return; }
    }
    try {
      const r = await this.api('PATCH', `/rentals/agreements/${id}/pickup-service`, body);
      this.closeModal();
      const fee = r.fee_change ? ` — ${r.fee_change > 0 ? `${this.fmt(r.fee_change)} added to` : `${this.fmt(-r.fee_change)} credited in`} the return settlement` : '';
      this.alert(`${action === 'add' ? 'Pickup added' : action === 'cancel' ? 'Pickup cancelled' : 'Pickup updated'}${fee}`);
      this.viewRentalAgreement(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Pickup: dispatcher assignment + driver field confirmation ─────────

  // Assign-side action (Rental Dispatch / agreement detail) — gated on
  // rentals_issue, same permission the Issue/Dispatch actions already use.
  async showAssignPickupDriverModal(id) {
    const employees = await this.api('GET', '/employees');
    const drivers = employees.filter(e => e.is_driver);
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header"><span class="modal-title">Assign Pickup Driver</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Driver</label>
            <select id="apd-driver">
              <option value="">-- Select --</option>
              ${drivers.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
            ${!drivers.length ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">No employees are flagged as a driver yet (Employees → edit → Driver checkbox).</div>` : ''}
          </div>
          <p style="font-size:12px;color:var(--text-muted)">The driver will see this pickup on their own dashboard and confirm it there once collected — no need to process the return yet.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitAssignPickupDriver(${id})">Assign</button>
        </div>
      </div>`);
  },

  async submitAssignPickupDriver(id) {
    const driverId = document.getElementById('apd-driver').value;
    if (!driverId) { this.alert('Select a driver', 'error'); return; }
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/assign-pickup-driver`, { driver_id: parseInt(driverId) });
      this.closeModal();
      this.alert('Pickup driver assigned');
      if (this.section === 'rental-dispatch') this.loadDispatchTab();
      else if (this.section === 'rentals') this.renderRentals();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Driver-side action (My Deliveries dashboard) — the customer enters their
  // own name and signs on the driver's device to confirm the item was
  // actually collected; no financial settlement happens here (that's still
  // Process Return, done later by whoever's at the counter).
  async showConfirmPickupModal(id) {
    // From the driver's own queue — the full agreement (with its amounts)
    // isn't open to a driver-only group.
    const a = (this._driverQueueCache||[]).find(x => x.id === id) || await this.api('GET', `/rentals/agreements/${id}`);
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><span class="modal-title">Confirm Pickup — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Have the customer enter their name and sign below to confirm this item was collected.</p>
          <div class="form-group"><label>Customer Name</label><input id="cp-customer-name" placeholder="Full name" value="${(a.customer_name||'').replace(/"/g,'&quot;')}"></div>
          ${this._rentalPhotoPickerHtml(id, 'pickup')}
          ${this._sigPadHtml('cp-customer-sig', 'Customer Signature', 'required — confirms the item was collected')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitConfirmPickup(${id})">Confirm Pickup</button>
        </div>
      </div>`);
    this._sigPadInit('cp-customer-sig');
    this._rentalPhotoLoad(id, 'pickup');
  },

  async submitConfirmPickup(id) {
    const name = document.getElementById('cp-customer-name').value.trim();
    if (!name) { this.alert("Enter the customer's name", 'error'); return; }
    if (!this._rentalPhotoReady('pickup')) return;
    if (!this._sigPadHasDrawn('cp-customer-sig')) { this.alert('Customer signature is required to confirm pickup', 'error'); return; }
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/confirm-pickup`, {
        customer_name: name,
        customer_signature: this._sigPadDataUrl('cp-customer-sig'),
      });
      this.closeModal();
      this.alert('Pickup confirmed');
      this.renderDriverDashboard();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Delivery: driver claim + field customer signature ─────────────────
  // Both modals read from _driverQueueCache (set by renderDriverDashboard)
  // rather than fetching the agreement fresh — the full GET
  // /rentals/agreements/:id route needs the broad `rentals` permission and
  // returns every financial column, which this restricted flow is built to
  // avoid ever reaching a driver's browser.
  showClaimDeliveryModal(id) {
    const a = (this._driverQueueCache||[]).find(x => x.id === id);
    if (!a) { this.alert('Delivery not found — refresh and try again', 'error'); return; }
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><span class="modal-title">Accept Delivery — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${a.item_summary || 'Item'} — for ${a.customer_name||'the customer'}. Sign below to confirm you're taking this out for delivery.</p>
          ${this._rentalDeliveryContactHtml(a)}
          <div style="margin-top:12px">${this._sigPadHtml('cd-driver-sig', 'Driver Signature', 'required — confirms you are taking custody for delivery')}</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitClaimDelivery(${id})">Accept &amp; Sign</button>
        </div>
      </div>`);
    this._sigPadInit('cd-driver-sig');
  },

  async submitClaimDelivery(id) {
    if (!this._sigPadHasDrawn('cd-driver-sig')) { this.alert('Signature is required to accept this delivery', 'error'); return; }
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/claim-delivery`, { driver_signature: this._sigPadDataUrl('cd-driver-sig') });
      this.closeModal();
      this.alert('Delivery accepted — get the customer to sign once you arrive');
      this.renderDriverDashboard();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showDeliveryCustomerSignatureModal(id) {
    const a = (this._driverQueueCache||[]).find(x => x.id === id);
    if (!a) { this.alert('Delivery not found — refresh and try again', 'error'); return; }
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><span class="modal-title">Customer Signature — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Have the customer enter their name and sign below to complete delivery of ${a.item_summary || 'the item'}. This is what starts the rental clock.</p>
          <div class="form-group"><label>Customer Name</label><input id="dcs-customer-name" placeholder="Full name" value="${(a.customer_name||'').replace(/"/g,'&quot;')}"></div>
          ${this._rentalPhotoPickerHtml(id, 'issue')}
          ${this._sigPadHtml('dcs-customer-sig', 'Customer Signature', 'required — confirms receipt and starts the rental')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitDeliveryCustomerSignature(${id})">Complete Delivery</button>
        </div>
      </div>`);
    this._sigPadInit('dcs-customer-sig');
    this._rentalPhotoLoad(id, 'issue');
  },

  async submitDeliveryCustomerSignature(id) {
    const name = document.getElementById('dcs-customer-name').value.trim();
    if (!name) { this.alert("Enter the customer's name", 'error'); return; }
    if (!this._rentalPhotoReady('issue')) return;
    if (!this._sigPadHasDrawn('dcs-customer-sig')) { this.alert('Customer signature is required to complete delivery', 'error'); return; }
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/issue`, {
        customer_name: name,
        customer_signature: this._sigPadDataUrl('dcs-customer-sig'),
      });
      this.closeModal();
      this.alert('Delivered — rental clock started');
      this.renderDriverDashboard();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Security's screen: no amounts anywhere — rows come from the slim
  // GET /rentals/agreements/guard-queue, and View (the full agreement, with
  // its money) only shows for someone who can manage rentals anyway.
  async renderGuardDashboard() {
    const rows = await this.api('GET', '/rentals/agreements/guard-queue');
    if (this.section !== 'guard-dashboard') return;
    this._guardDashCache = rows;
    const canView = this._canManageRentals();
    const canSign = this.can('rentals_security_signoff');
    const awaitingCheck = rows.filter(a => a.status === 'awaiting_issue' && !a.issue_security_employee_id);
    const expectedReturns = rows.filter(a => a.status === 'active').sort((a,b) => (a.due_date||'').localeCompare(b.due_date||''));
    const myId = this.currentUser.id;
    const history = rows
      .filter(a => a.issue_security_employee_id === myId || a.return_security_employee_id === myId)
      .map(a => ({ a, at: a.return_security_confirmed_at || a.issue_security_confirmed_at || a.created_at }))
      .sort((x,y) => (y.at||'').localeCompare(x.at||''))
      .slice(0, 8)
      .map(x => x.a);
    const how = a => `<div style="font-size:11px;color:var(--text-muted)">${a.delivery_required ? 'Going out for delivery' : 'Customer collecting'}${a.accessory_summary ? ` · with ${this.escapeAttr(a.accessory_summary)}` : ''}</div>`;
    const action = a => !canSign ? '' : a.delivery_required
      ? `<button class="btn btn-sm btn-primary" onclick="App.showSecuritySignoffModal(${a.id})">Sign Off</button>`
      : `<button class="btn btn-sm btn-primary" onclick="App.showGuardIssueModal(${a.id})">Hand Over</button>`;

    const returnNote = a => a.return_checkin_at
      ? `<div style="font-size:11px;color:#166534;font-weight:600">✓ Checked in ${this.fmtDateTime(a.return_checkin_at)}${a.return_checkin_by_name ? ` by ${this.escapeAttr(a.return_checkin_by_name)}` : ''} — waiting for the cashier</div>`
      : a.is_paused ? '<div style="font-size:11px;color:var(--warning)">Paused — the rental desk resumes it first</div>'
      : a.pickup_required ? `<div style="font-size:11px;color:var(--text-muted)">${a.pickup_confirmed_at ? 'Collected by our driver' : 'Our driver collects it'}</div>` : '';
    const returnAction = a => !canSign ? ''
      : a.return_checkin_at ? (a.return_checkin_by === myId ? `<button class="btn btn-sm btn-outline" onclick="App._undoRentalCheckin(${a.id})">Undo</button>` : '')
      : a.is_paused ? '' : `<button class="btn btn-sm btn-primary" onclick="App.showGuardCheckInModal(${a.id})">Check In</button>`;

    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>My Verifications</h2></div>
      ${this._rentalDashSection('Awaiting Security Check', awaitingCheck.map(a => this._rentalDashRow(a, how(a), action(a), '', canView)), 'Nothing waiting on a security check right now.')}
      ${this._rentalDashSection('Expected Returns', expectedReturns.map(a => this._rentalDashRow(a, returnNote(a), returnAction(a), '', canView)), 'No active rentals outstanding.')}
      ${this._rentalDashSection('My Recent Verifications', history.map(a => this._rentalDashRow(a, `<div style="font-size:11px;color:var(--text-muted)">${a.display_status}</div>`, '', '', canView)), 'No verifications recorded yet.')}
    `;
  },

  // Self-service — the logged-in guard IS the signer. Delivery: photos are
  // optional here (they count toward the issue photos the driver would
  // otherwise take at the customer's).
  showSecuritySignoffModal(id) {
    const a = (this._guardDashCache||[]).find(x => x.id === id);
    if (!a) { this.alert('Agreement not found — refresh and try again', 'error'); return; }
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Security Sign-Off — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">${a.item_summary || 'Item'} is going out for delivery. Sign below to confirm it's clear to leave.</p>
          ${this._rentalPhotoPickerHtml(id, 'issue').replace('(required — at least one of the item(s) as it goes out)', '(optional — the item(s) as they leave)')}
          ${this._sigPadHtml('ss-guard-sig', 'Guard Signature', 'required — confirms this item is clear to leave')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitSecuritySignoff(${id})">Sign Off</button>
        </div>
      </div>`);
    this._sigPadInit('ss-guard-sig');
    this._rentalPhotoLoad(id, 'issue');
  },

  // Customer collecting at the counter (no delivery): the guard hands it
  // over — photos, their own signature, the customer's name and signature —
  // and the rental clock starts now. Nothing about money is shown.
  showGuardIssueModal(id) {
    const a = (this._guardDashCache||[]).find(x => x.id === id);
    if (!a) { this.alert('Agreement not found — refresh and try again', 'error'); return; }
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Hand Over — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:12px;font-size:13px">
            <strong>${this.escapeAttr(a.item_summary || 'Item')}</strong>
            ${a.accessory_summary ? `<div style="font-size:12px;color:var(--text-muted)">+ ${this.escapeAttr(a.accessory_summary)}</div>` : ''}
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">For ${this.escapeAttr(a.customer_name || '—')} · due back ${this.fmtDate(a.due_date)}</div>
          </div>
          ${this._rentalPhotoPickerHtml(id, 'issue')}
          ${this._sigPadHtml('gi-guard-sig', 'Guard Signature', 'required — you confirm the item(s) are clear to leave')}
          <div class="form-group" style="margin-top:12px"><label>Collected By *</label><input id="gi-customer-name" placeholder="Full name" value="${this.escapeAttr(a.customer_name || '')}"></div>
          ${this._sigPadHtml('gi-customer-sig', 'Customer Signature', 'required — confirms receipt and starts the rental')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitGuardIssue(${id})">Hand Over &amp; Start Rental</button>
        </div>
      </div>`);
    this._sigPadInit('gi-guard-sig');
    this._sigPadInit('gi-customer-sig');
    this._rentalPhotoLoad(id, 'issue');
  },

  // Return check-in at the gate: what came back and its condition, photos,
  // the guard's signature. The cashier's Process Return settles the money.
  showGuardCheckInModal(id) {
    const a = (this._guardDashCache||[]).find(x => x.id === id);
    if (!a) { this.alert('Agreement not found — refresh and try again', 'error'); return; }
    const out = (a.items || []).filter(i => i.quantity_returned < i.quantity);
    this.showModal(`
      <div class="modal" style="max-width:500px">
        <div class="modal-header"><span class="modal-title">Check In Return — ${a.agreement_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">From ${this.escapeAttr(a.customer_name || '—')} · due ${this.fmtDate(a.due_date)}. Enter how many of each came back and what condition it's in.</div>
          ${out.map(i => `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:8px">
              <div class="fw-600" style="font-size:13px">${this.escapeAttr(i.product_name)}${this._rentalSkuTag(i.sku)}${i.parent_item_id ? ' <span class="badge-pill badge-secondary" style="font-size:10px">accessory</span>' : ''} <span style="font-weight:400;color:var(--text-muted);font-size:12px">(${i.quantity - i.quantity_returned} out)</span></div>
              <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
                <div class="form-group" style="margin:0;width:90px"><label style="font-size:11px">Back</label><input type="number" class="gc-qty" data-item="${i.id}" value="${i.quantity - i.quantity_returned}" min="0" max="${i.quantity - i.quantity_returned}" step="1"></div>
                <div class="form-group" style="margin:0;flex:1;min-width:180px"><label style="font-size:11px">Condition</label><input class="gc-cond" data-item="${i.id}" placeholder="e.g. Good, or describe any damage"></div>
              </div>
            </div>`).join('')}
          ${this._rentalPhotoPickerHtml(id, 'return')}
          ${this._sigPadHtml('gc-guard-sig', 'Guard Signature', 'required — you confirm what came back')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitGuardCheckIn(${id})">Check In</button>
        </div>
      </div>`);
    this._sigPadInit('gc-guard-sig');
    this._rentalPhotoLoad(id, 'return');
  },

  async submitGuardCheckIn(id) {
    const items = [...document.querySelectorAll('.gc-qty')].map(el => ({
      item_id: Number(el.dataset.item),
      quantity: Number(el.value) || 0,
      condition: document.querySelector(`.gc-cond[data-item="${el.dataset.item}"]`)?.value.trim() || null,
    }));
    if (!items.some(i => i.quantity > 0)) { this.alert('Enter how many of each item came back', 'error'); return; }
    if (!this._rentalPhotoReady('return')) return;
    if (!this._sigPadHasDrawn('gc-guard-sig')) { this.alert('Your signature is required', 'error'); return; }
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/return-checkin`, { items, security_signature: this._sigPadDataUrl('gc-guard-sig') });
      this.closeModal();
      this.alert('Checked in — the cashier will process the return');
      this.renderGuardDashboard();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _undoRentalCheckin(id, fromReturnModal = false) {
    if (!confirm('Undo this check-in? The item(s) will show as still out until checked in again.')) return;
    try {
      await this.api('DELETE', `/rentals/agreements/${id}/return-checkin`);
      this.alert('Check-in undone');
      if (fromReturnModal) { this.closeModal(); this.showRentalReturnModal(id); }
      else if (this.section === 'guard-dashboard') this.renderGuardDashboard();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async submitGuardIssue(id) {
    if (!this._rentalPhotoReady('issue')) return;
    if (!this._sigPadHasDrawn('gi-guard-sig')) { this.alert('Your signature is required', 'error'); return; }
    const name = document.getElementById('gi-customer-name').value.trim();
    if (!name) { this.alert('Enter the name of the person collecting it', 'error'); return; }
    if (!this._sigPadHasDrawn('gi-customer-sig')) { this.alert('Customer signature is required', 'error'); return; }
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/issue`, {
        customer_name: name,
        security_signature: this._sigPadDataUrl('gi-guard-sig'),
        customer_signature: this._sigPadDataUrl('gi-customer-sig'),
      });
      this.closeModal();
      this.alert('Handed over — rental clock started');
      this.renderGuardDashboard();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async submitSecuritySignoff(id) {
    if (!this._sigPadHasDrawn('ss-guard-sig')) { this.alert('Signature is required to sign off', 'error'); return; }
    try {
      await this.api('PATCH', `/rentals/agreements/${id}/security-signoff`, { security_signature: this._sigPadDataUrl('ss-guard-sig') });
      this.closeModal();
      this.alert('Signed off — this delivery is now available to drivers');
      this.renderGuardDashboard();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async renderDashboard() {
    document.getElementById('content').innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    const branches = this.currentUser.branches || [];
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Dashboard ${this.currentUser.is_salesperson ? '<span style="font-size:12px;font-weight:normal;color:var(--text-muted);border:1px solid var(--border);border-radius:4px;padding:2px 8px;margin-left:8px;vertical-align:middle">My Sales Only</span>' : ''}</h2>
        <div>
          <select id="dash-branch" onchange="App.loadDashboard(this.value)" style="width:180px">
            <option value="">All Branches</option>
            ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="dash-content"><div class="empty-state"><p>Loading...</p></div></div>`;
    await this.loadDashboard('');
  },

  async loadDashboard(branchId = '') {
    const url = `/reports/dashboard${branchId ? `?branch_id=${branchId}` : ''}`;
    let data;
    try {
      data = await this.api('GET', url);
    } catch(e) {
      const el = document.getElementById('dash-content');
      if (el) el.innerHTML = `<div class="empty-state"><p>Failed to load dashboard: ${e.message}</p></div>`;
      return;
    }
    // The user may have navigated away from the Dashboard while this fetch was
    // in flight — #dash-content would be gone, so bail out instead of throwing.
    if (!document.getElementById('dash-content')) return;
    const s = data.todayStats, m = data.monthStats;

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const dayMap = {};
    data.last7Days.forEach(r => { dayMap[r.date] = r.sales; });
    const maxSales = Math.max(...days.map(d => dayMap[d] || 0), 1);

    const chartBars = days.map(d => {
      const sales = dayMap[d] || 0;
      const h = Math.round((sales / maxSales) * 100);
      const label = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
      return `<div class="chart-bar-wrap"><div class="chart-bar-track"><div class="chart-bar" style="height:${h}%" title="${label}: ${this.fmt(sales)}"><div class="chart-bar-val">${sales > 0 ? this.fmt(sales) : ''}</div></div></div><div class="chart-bar-label">${label}</div></div>`;
    }).join('');

    // Location breakdown section (shown when viewing all branches)
    const locationSection = (!branchId && data.byLocation && data.byLocation.length > 1) ? (() => {
      const locColors = ['#3b6bc4','#2e9e5b','#e67e22','#e74c3c','#8e44ad','#16a085','#d35400','#2980b9'];
      const maxLocSales = Math.max(...data.byLocation.map(l => l.today_sales), 1);
      const locCards = data.byLocation.map((loc, i) => {
        const color = locColors[i % locColors.length];
        const pct = Math.round((loc.today_sales / maxLocSales) * 100);
        const cityState = [loc.city, loc.state].filter(Boolean).join(', ');
        return `
          <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></div>
              <div style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${loc.name}</div>
            </div>
            ${cityState ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${cityState}</div>` : ''}
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:12px;color:var(--text-muted)">Today</span>
              <span style="font-weight:700;font-size:14px;color:${color}">${this.fmt(loc.today_sales)}</span>
            </div>
            <div style="background:#f0f0f0;border-radius:4px;height:6px;margin-bottom:10px">
              <div style="background:${color};height:6px;border-radius:4px;width:${pct}%"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--text-muted)">MTD</span>
              <span style="font-weight:600">${this.fmt(loc.month_sales)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-top:2px">
              <span style="color:var(--text-muted)">Transactions</span>
              <span style="color:var(--text-muted)">${loc.today_transactions} today · ${loc.month_transactions} MTD</span>
            </div>
          </div>`;
      }).join('');
      return `
        <div class="card" style="margin-bottom:20px">
          <div class="card-header"><span class="card-title">Sales by Location</span></div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding:12px 0 4px">
            ${locCards}
          </div>
        </div>`;
    })() : '';

    document.getElementById('dash-content').innerHTML = `
      <div class="stats-grid">
        <div class="stat-card blue">
          <div class="stat-label">Today's Sales</div>
          <div class="stat-value">${this.fmt(s.sales)}</div>
          <div class="stat-sub">${s.transactions} transactions</div>
        </div>
        <div class="stat-card green">
          <div class="stat-label">Month to Date</div>
          <div class="stat-value">${this.fmt(m.sales)}</div>
          <div class="stat-sub">${m.transactions} transactions</div>
        </div>
        <div class="stat-card orange">
          <div class="stat-label">Total Customers</div>
          <div class="stat-value">${data.totalCustomers.count}</div>
          <div class="stat-sub">Active accounts</div>
        </div>
        <div class="stat-card red">
          <div class="stat-label">Low Stock Items</div>
          <div class="stat-value">${data.lowStock.count}</div>
          <div class="stat-sub">Need restocking</div>
        </div>
      </div>
      ${locationSection}
      <div class="two-col">
        <div class="card">
          <div class="card-header"><span class="card-title">Sales Last 7 Days</span></div>
          <div class="chart-bars">${chartBars}</div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Recent Transactions</span></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Tx #</th><th>Customer</th><th>Total</th><th>Method</th><th>Time</th></tr></thead>
              <tbody>
                ${data.recentTx.map(tx => `
                  <tr>
                    <td class="fw-600">${tx.transaction_number}</td>
                    <td>${tx.customer_name || '<em style="color:#999">Walk-in</em>'}</td>
                    <td class="fw-600">${this.fmt(tx.total)}</td>
                    <td><span class="badge-pill badge-info">${tx.payment_method}</span></td>
                    <td style="color:var(--text-muted)">${this.fmtDateTime(tx.created_at)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  },

});
