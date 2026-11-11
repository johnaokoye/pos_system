// Branch transfers and transfer dispatch.
Object.assign(App, {
  // ─── Branch Transfers ─────────────────────────────────────
  async renderTransfers() {
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    const [transfers] = await Promise.all([
      this.api('GET', '/transfers?limit=100'),
    ]);
    if (this.section !== 'transfers') return;
    const branches = this.currentUser.branches || [];
    const statusColor = this._transferStatusColor;
    c.innerHTML = `
      <div class="section-header">
        <h2>Branch Transfers</h2>
        <div style="display:flex;gap:8px">
          ${this.can('transfers_quick') ? `<button class="btn btn-outline" onclick="App.showTransferForm(null, { quick: true })" title="Move stock between branches instantly — no request, pickup or receiving">⚡ Quick Transfer</button>` : ''}
          ${this.can('transfers_create') ? `<button class="btn btn-primary" onclick="App.showTransferForm()">+ Request Transfer</button>` : ''}
        </div>
      </div>
      <div class="card">
        <div style="margin-bottom:10px">
          <div class="search-bar" style="max-width:280px">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            <input type="text" id="trf-search" placeholder="Search transfer #..." style="width:220px">
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Transfer #</th><th>From</th><th>To</th><th>Status</th><th>Created</th><th>Date Received</th><th>Actions</th></tr></thead>
            <tbody id="trf-tbody">
              ${transfers.length ? transfers.map(t => `
                <tr data-trf-num="${(t.transfer_number||'').toLowerCase()}">
                  <td class="fw-600">${t.transfer_number}${this._transferCustomerOrderBadge(t)}</td>
                  <td>${t.from_branch_name||'-'}</td>
                  <td>${t.to_branch_name||'-'}</td>
                  <td><span class="badge-pill ${statusColor[t.status]||'badge-info'}">${this._transferStatusLabel(t.status)}</span>${t.is_quick ? ' <span class="badge-pill badge-secondary" title="Quick transfer — moved instantly">⚡ Quick</span>' : ''}</td>
                  <td style="color:var(--text-muted)">${this.fmtDate(t.created_at)}</td>
                  <td style="color:var(--text-muted)">${t.received_at ? this.fmtDate(t.received_at) : '—'}</td>
                  <td>
                    <button class="btn btn-sm btn-secondary" onclick="App.viewTransfer(${t.id})">View</button>
                    ${t.status==='requested' && this.can('transfers_approve') ? `<button class="btn btn-sm btn-primary" onclick="App.showSendTransfer(${t.id})">Review &amp; Send</button>` : ''}
                    ${t.status==='requested'||t.status==='pending' ? `<button class="btn btn-sm btn-outline" onclick="App.printTransferPickList(${t.id})" title="Print Pick List">🗒 Pick List</button>` : ''}
                    ${(t.status==='pending'||t.status==='in_transit') && this.can('transfers_dropoff') ? `<button class="btn btn-sm btn-success" onclick="App.showReceiveTransfer(${t.id})">Receive</button>` : ''}
                  </td>
                </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No transfers yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
    const trfSearch = document.getElementById('trf-search');
    if (trfSearch) {
      trfSearch.addEventListener('input', () => {
        const q = trfSearch.value.toLowerCase().trim();
        document.querySelectorAll('#trf-tbody tr[data-trf-num]').forEach(row => {
          row.style.display = !q || row.dataset.trfNum.includes(q) ? '' : 'none';
        });
      });
    }
    this._transferBranches = branches;
  },

  // prefill (optional): { fromBranchId, productId } — used by Rental Items'
  // "Transfer" action to jump straight into a transfer of one specific item
  // instead of making the user reselect the branch and product by hand.
  // A transfer starts as a request: the branch that needs stock asks another
  // branch for it; the inventory team there sets what's actually sent
  // (showSendTransfer) and the requesting branch receives it.
  // { quick: true } — Quick Transfer (transfers_quick): pick any source and
  // destination and the stock moves at once (POST /transfers/quick), for
  // branches in the same building.
  async showTransferForm(prefill, { quick = false } = {}) {
    // Ask any branch, for one of your own (the one receiving it).
    const myBranches = this.currentUser.branches || [];
    const allBranches = await this.api('GET', '/branches').catch(() => myBranches);
    const toBranches = quick ? allBranches : myBranches;
    this._transferProducts = [];
    this._transferItemIdx = 0;
    this._transferQuick = quick;
    this.showModal(`
      <div class="modal" style="max-width:720px">
        <div class="modal-header"><span class="modal-title">${quick ? '⚡ Quick Transfer' : 'Request Branch Transfer'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">${quick ? 'Stock moves the moment you click Transfer — out of the source branch and into the destination. No request, pickup or receiving; use it for branches in the same building.' : "No stock moves yet — the sending branch's inventory team confirms the quantities and sends it, then you receive it."}</p>
          <div class="input-row">
            <div class="form-group"><label>${quick ? 'From (source branch)' : 'Request From (sending branch)'} *</label>
              <select id="trf-from" onchange="App.onTransferFromChange()">
                <option value="">-- Select Source --</option>
                ${allBranches.map(b => `<option value="${b.id}" ${prefill?.fromBranchId && String(prefill.fromBranchId)===String(b.id)?'selected':''}>${b.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>${quick ? 'To (destination branch)' : 'Deliver To (receiving branch)'} *</label>
              <select id="trf-to">
                <option value="">-- Select Destination --</option>
                ${toBranches.map(b => `<option value="${b.id}" ${!quick && myBranches.length === 1 ? 'selected' : ''}>${b.name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group"><label>Notes</label><input id="trf-notes"></div>
          <div style="margin-bottom:10px">
            <div class="card-header"><span class="card-title">${quick ? 'Items to Move' : 'Items Requested'}</span><button class="btn btn-sm btn-outline" id="trf-add-btn" onclick="App.addTransferItem()" disabled>+ Add Item</button></div>
            <div id="trf-items"><p style="color:var(--text-muted);font-size:13px;padding:8px 0">Select a source branch to load available products.</p></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="trf-save" onclick="App.saveTransfer()">${quick ? '⚡ Transfer Now' : 'Send Request'}</button>
        </div>
      </div>`);
    if (prefill?.fromBranchId) await this.onTransferFromChange(prefill.productId);
    // Item lines are added dynamically (addTransferItem), so this closes
    // whichever trfi-prod-dd-* dropdown is currently open rather than
    // binding to a specific line's id — same pattern as the Quotation
    // item picker.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.trfi-prod-search-wrap')) {
        document.querySelectorAll('[id^="trfi-prod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
      }
    });
  },

  // preselectedId (optional): passed through when the source-branch load was
  // triggered by showTransferForm's prefill, so the one item it cares about
  // gets added automatically instead of leaving the item list empty.
  async onTransferFromChange(preselectedId) {
    const branchId = document.getElementById('trf-from')?.value;
    const container = document.getElementById('trf-items');
    const addBtn = document.getElementById('trf-add-btn');
    if (!container) return;
    if (!branchId) {
      this._transferProducts = [];
      this._transferItemIdx = 0;
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">Select a source branch to load available products.</p>';
      if (addBtn) addBtn.disabled = true;
      return;
    }
    container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">Loading…</p>';
    const all = await this.api('GET', `/products?active=1&branch_id=${branchId}`);
    // A rental item's stock_qty is the total owned count, not what's free to
    // move — units currently out on an active rental from this branch don't
    // physically sit on the shelf here, so they're excluded from what can be
    // transferred (matches the same subtraction the server enforces).
    all.forEach(p => { p.available_qty = (p.stock_qty || 0) - (p.rental_outstanding_qty || 0); });
    this._transferProducts = all.filter(p => p.available_qty > 0);
    this._transferItemIdx = 0;
    container.innerHTML = '';
    if (addBtn) addBtn.disabled = false;
    if (this._transferProducts.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No products with available stock at this branch.</p>';
      if (addBtn) addBtn.disabled = true;
      return;
    }
    this.addTransferItem(preselectedId);
  },

  addTransferItem(preselectedId) {
    const container = document.getElementById('trf-items');
    if (!container) return;
    const products = this._transferProducts || [];
    if (!products.length) return;
    const idx = this._transferItemIdx++;
    const preselectedProduct = preselectedId ? products.find(p => String(p.id) === String(preselectedId)) : null;
    const prefillLabel = preselectedProduct ? `${preselectedProduct.name} (${preselectedProduct.sku})${preselectedProduct.is_rental?' [Rental]':''} — Avail: ${preselectedProduct.available_qty}` : '';
    const div = document.createElement('div');
    div.className = 'po-receive-row';
    div.id = `trf-item-${idx}`;
    div.innerHTML = `
      <span class="trfi-prod-search-wrap" style="flex:2;position:relative">
        <input type="text" id="trfi-prod-search-${idx}" placeholder="Search products…" autocomplete="off" style="width:100%"
          value="${this.escapeAttr(prefillLabel)}"
          oninput="App._filterTransferItemOptions(${idx},this.value)" onfocus="App._filterTransferItemOptions(${idx},this.value)">
        <input type="hidden" id="trfi-prod-${idx}" value="${preselectedProduct?preselectedProduct.id:''}" data-stock="${preselectedProduct?preselectedProduct.available_qty:''}">
        <div id="trfi-prod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
      </span>
      <input id="trfi-qty-${idx}" type="number" min="1" value="1" style="width:80px" placeholder="Qty">
      <span id="trfi-stock-${idx}" style="font-size:12px;color:var(--text-muted);white-space:nowrap">${preselectedProduct?`Avail: ${preselectedProduct.available_qty}`:''}</span>
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('trf-item-${idx}').remove()">✕</button>`;
    container.appendChild(div);
  },

  // Searchable replacement for what used to be a plain <select> of every
  // product available at the source branch — same pattern as the
  // Quotation item picker. saveTransfer reads trfi-prod-${idx}'s value
  // directly (a hidden input here, same id/semantics as the old select).
  _filterTransferItemOptions(idx, query) {
    const dd = document.getElementById(`trfi-prod-dd-${idx}`);
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._transferProducts || []).filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectTransferItemOption(${idx},${p.id})">
        <strong>${p.name}${p.is_rental?' [Rental]':''}</strong>
        <div style="font-size:11px;color:var(--text-muted)">Avail: ${p.available_qty}${p.sku ? ' · ' + p.sku : ''}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No products found</div>`;
    dd.style.display = '';
  },

  _selectTransferItemOption(idx, productId) {
    const p = (this._transferProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById(`trfi-prod-${idx}`);
    const searchEl = document.getElementById(`trfi-prod-search-${idx}`);
    const dd = document.getElementById(`trfi-prod-dd-${idx}`);
    if (hidden) { hidden.value = productId; hidden.dataset.stock = p.available_qty; }
    if (searchEl) searchEl.value = `${p.name} (${p.sku})${p.is_rental?' [Rental]':''} — Avail: ${p.available_qty}`;
    if (dd) dd.style.display = 'none';
    this.onTransferProductChange(idx);
  },

  onTransferProductChange(idx) {
    const hidden = document.getElementById(`trfi-prod-${idx}`);
    const stockEl = document.getElementById(`trfi-stock-${idx}`);
    const qtyEl = document.getElementById(`trfi-qty-${idx}`);
    if (!hidden || !hidden.value) { if (stockEl) stockEl.textContent = ''; return; }
    const stock = parseInt(hidden.dataset.stock) || 0;
    if (stockEl) stockEl.textContent = `Avail: ${stock}`;
  },

  async saveTransfer() {
    const from_branch_id = document.getElementById('trf-from').value;
    const to_branch_id = document.getElementById('trf-to').value;
    const notes = document.getElementById('trf-notes').value;
    if (!from_branch_id) { this.alert('Select a source branch', 'error'); return; }
    if (!to_branch_id) { this.alert('Select a destination branch', 'error'); return; }
    if (from_branch_id === to_branch_id) { this.alert('Source and destination must differ', 'error'); return; }
    const items = [];
    document.querySelectorAll('#trf-items [id^="trf-item-"]').forEach(line => {
      const idx = line.id.replace('trf-item-','');
      const product_id = document.getElementById(`trfi-prod-${idx}`)?.value;
      if (!product_id) return;
      const qty = parseInt(document.getElementById(`trfi-qty-${idx}`).value) || 1;
      items.push({ product_id, quantity: qty });
    });
    if (!items.length) { this.alert('Add at least one item', 'error'); return; }
    const quick = this._transferQuick;
    const btn = document.getElementById('trf-save');
    if (btn) btn.disabled = true;
    try {
      const t = await this.api('POST', quick ? '/transfers/quick' : '/transfers', { from_branch_id, to_branch_id, notes, items });
      this.closeModal();
      this.alert(quick ? `${t.transfer_number}: ${items.length} item${items.length > 1 ? 's' : ''} moved from ${t.from_branch_name} to ${t.to_branch_name}` : 'Transfer requested — the sending branch will confirm quantities and send it');
      // Not renderTransfers() directly — it can be opened from other
      // sections (e.g. Rental Items' "Transfer" quick action), and
      // renderTransfers() bails out after its own "Loading..." placeholder
      // if this.section isn't already 'transfers' by the time its fetch
      // resolves, leaving the screen stuck. showSection() sets that first.
      this.showSection('transfers');
    } catch(e) { this.alert(e.message, 'error'); if (btn) btn.disabled = false; }
  },

  _transferStatusColor: { requested:'badge-secondary', pending:'badge-warning', in_transit:'badge-info', received:'badge-success', cancelled:'badge-danger' },
  // 'pending' is a sent transfer waiting for pickup / receiving.
  _transferStatusLabel(status) {
    return { requested: 'requested', pending: 'sent', in_transit: 'in transit' }[status] || status;
  },

  async viewTransfer(id) {
    const t = await this.api('GET', `/transfers/${id}`);
    const statusColor = this._transferStatusColor;
    // Sent = stock left the source: anything past 'requested', except a
    // request cancelled before sending (no sent_at; transfers from before
    // requests existed have no quantity_asked).
    const sent = t.status !== 'requested' && (!!t.sent_at || t.status !== 'cancelled' || t.items.every(i => i.quantity_asked == null));
    this.showModal(`
      <div class="modal" style="max-width:660px">
        <div class="modal-header">
          <span class="modal-title">Transfer: ${t.transfer_number}</span>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="badge-pill ${statusColor[t.status]||''}">${this._transferStatusLabel(t.status)}</span>
            <button class="modal-close">✕</button>
          </div>
        </div>
        <div class="modal-body">
          <div class="two-col" style="margin-bottom:14px;font-size:13px">
            <div><strong>From:</strong> ${t.from_branch_name||'-'}</div>
            <div><strong>To:</strong> ${t.to_branch_name||'-'}</div>
            <div><strong>Requested by:</strong> ${t.employee_name||'-'} · ${this.fmtDate(t.created_at)}</div>
            ${t.sent_at ? `<div><strong>Sent by:</strong> ${t.sent_by_name||'-'} · ${this.fmtDate(t.sent_at)}</div>` : ''}
            ${t.dispatched_at ? `<div><strong>Picked up by:</strong> ${this.escapeAttr(t.driver_display_name||'-')} · ${this.fmtDateTime(t.dispatched_at)}${t.dispatched_by_name && t.dispatched_by_name !== t.driver_display_name ? ` <span style="color:var(--text-muted)">(marked by ${this.escapeAttr(t.dispatched_by_name)})</span>` : ''}</div>` : ''}
          </div>
          ${this._transferCustomerOrderBanner(t)}
          ${t.notes ? `<p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">${t.notes}</p>` : ''}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Product</th><th>SKU</th><th>Requested</th>${sent ? '<th>Sent</th><th>Received</th>' : ''}</tr></thead>
              <tbody>
                ${t.items.map(i => `<tr>
                  <td>${i.product_name}</td>
                  <td>${i.sku||'-'}</td>
                  <td>${i.quantity_asked ?? i.quantity_requested}</td>
                  ${sent ? `<td><span class="${i.quantity_asked != null && i.quantity_requested < i.quantity_asked ? 'color-warning fw-600' : ''}">${i.quantity_requested}</span></td>
                  <td><span class="${(i.quantity_received||0)>=i.quantity_requested?'color-success':'color-warning'}">${i.quantity_received||0}</span></td>` : ''}
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          ${(t.receipts || []).length ? `
          <h4 style="font-size:13px;margin:16px 0 6px">Deliveries Received</h4>
          <div class="table-wrap"><table>
            <thead><tr><th>Received</th><th>Delivered by</th><th>Received by</th><th>Items</th></tr></thead>
            <tbody>${t.receipts.map(r => `<tr>
              <td style="white-space:nowrap">${this.fmtDateTime(r.received_at)}</td>
              <td>${this.escapeAttr(r.delivered_by_display || '—')}</td>
              <td>${this.escapeAttr(r.received_by_name || '—')}</td>
              <td style="font-size:12px">${r.lines.map(l => `${this.escapeAttr(l.product_name)} × ${l.quantity}`).join('<br>')}${r.notes ? `<div style="color:var(--text-muted)">${this.escapeAttr(r.notes)}</div>` : ''}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : (t.status === 'received' ? '<p style="font-size:12px;color:var(--text-muted);margin-top:12px">Received before deliveries were recorded — who delivered and received it wasn\'t captured.</p>' : '')}
        </div>
        <div class="modal-footer">
          ${t.status==='requested' && this.can('transfers_approve') ? `<button class="btn btn-primary" onclick="App.closeModal();App.showSendTransfer(${t.id})">Review &amp; Send</button>` : ''}
          ${t.status!=='cancelled' ? `<button class="btn btn-outline" onclick="App.printTransferPickList(${t.id})">🗒 Print Pick List</button>` : ''}
          ${t.status==='pending' && this.can('transfers_pickup') ? `<button class="btn btn-secondary" onclick="App.dispatchTransfer(${t.id})">Mark In-Transit</button>` : ''}
          ${t.status!=='cancelled'&&t.status!=='received' ? `<button class="btn btn-danger" onclick="App.cancelTransfer(${t.id})">Cancel</button>` : ''}
          ${(t.status==='pending'||t.status==='in_transit') && this.can('transfers_dropoff') ? `<button class="btn btn-success" onclick="App.closeModal();App.showReceiveTransfer(${t.id})">Receive Items</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  // Both the Warehouse "Branch Transfers" screen and the Dispatch "Branch
  // Transfers" page call the same dispatch/receive/cancel actions — refresh
  // whichever one is actually on screen instead of always bouncing back to
  // the Warehouse screen.
  _refreshTransferView() {
    if (this.section === 'transfer-dispatch') this.loadTransferDispatch();
    else this.renderTransfers();
    this._pollTransferInbox(); // sent / cancelled requests leave the badge count
  },

  // Employees for the carrier pickers (GET /transfers/people), drivers first.
  async _transferPeople() {
    if (!this._transferPeopleCache) this._transferPeopleCache = await this.api('GET', '/transfers/people').catch(() => []);
    return this._transferPeopleCache;
  },

  // "Who carried it" picker: an employee, or Someone else with a typed name
  // (an outside courier). Read back with _readCarrier(prefix).
  _carrierPickerHtml(prefix, people, { id = null, name = '' } = {}) {
    const drivers = people.filter(p => p.is_driver), others = people.filter(p => !p.is_driver);
    const opt = p => `<option value="${p.id}" ${String(id) === String(p.id) ? 'selected' : ''}>${this.escapeAttr(p.name)}</option>`;
    const other = !id && !!name;
    return `
      <select id="${prefix}-emp" onchange="document.getElementById('${prefix}-name').style.display = this.value === 'other' ? '' : 'none'">
        <option value="">— Select —</option>
        ${drivers.length ? `<optgroup label="Drivers">${drivers.map(opt).join('')}</optgroup>` : ''}
        <optgroup label="${drivers.length ? 'Other employees' : 'Employees'}">${others.map(opt).join('')}</optgroup>
        <option value="other" ${other ? 'selected' : ''}>Someone else (outside courier)…</option>
      </select>
      <input id="${prefix}-name" placeholder="Name of the person / courier" value="${this.escapeAttr(other ? name : '')}" style="margin-top:6px;${other ? '' : 'display:none'}">`;
  },
  _readCarrier(prefix) {
    const v = document.getElementById(`${prefix}-emp`)?.value;
    if (v === 'other') return { name: document.getElementById(`${prefix}-name`).value.trim() };
    return v ? { id: Number(v) } : {};
  },

  // Picked Up: record who's taking the stock to the other branch.
  async dispatchTransfer(id) {
    const people = await this._transferPeople();
    const me = this.currentUser?.id;
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Picked Up — In Transit</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Who is taking it? *</label>${this._carrierPickerHtml('tdisp', people, { id: people.some(p => p.id === me) ? me : null })}</div>
          <p style="font-size:12px;color:var(--text-muted);margin:0">They'll be shown as the deliverer when the other branch receives it.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.confirmDispatchTransfer(${id})">Mark In-Transit</button>
        </div>
      </div>`);
  },

  async confirmDispatchTransfer(id) {
    const driver = this._readCarrier('tdisp');
    if (!driver.id && !driver.name) { this.alert('Choose who is taking it', 'error'); return; }
    try {
      await this.api('PATCH', `/transfers/${id}/dispatch`, { driver_id: driver.id || null, driver_name: driver.name || null });
      this.closeModal();
      this.alert('Transfer marked as in-transit');
      this._refreshTransferView();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async cancelTransfer(id) {
    const t = await this.api('GET', `/transfers/${id}`).catch(() => null);
    const isRequest = t?.status === 'requested';
    if (!confirm(isRequest ? 'Cancel this transfer request?' : 'Cancel this transfer? Unreceived quantities will be returned to the source branch.')) return;
    try {
      await this.api('PATCH', `/transfers/${id}/cancel`, {});
      this.closeModal();
      this.alert(isRequest ? 'Transfer request cancelled' : 'Transfer cancelled — stock restored to source branch');
      this._refreshTransferView();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Inventory team: set what's actually being sent for each requested line
  // (defaults to the ask, capped at what the sending branch has free), then
  // send — stock leaves the sending branch at this point.
  async showSendTransfer(id) {
    const t = await this.api('GET', `/transfers/${id}`);
    this._sendingTransfer = t;
    if (t.status !== 'requested') { this.alert('This transfer has already been sent', 'warning'); return this.viewTransfer(id); }
    const stock = t.items.map(i => i.product_id ? (i.source_stock ?? 0) : null);
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">Send Transfer — ${t.transfer_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:6px">From <strong>${t.from_branch_name}</strong> to <strong>${t.to_branch_name}</strong> · requested by ${t.employee_name || '—'}</p>
          ${this._transferCustomerOrderBanner(t)}
          ${t.notes ? `<p style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${t.notes}</p>` : ''}
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Enter the quantity you're sending for each item (0 to leave it out). Stock is taken from ${t.from_branch_name} when you send.</p>
          ${t.items.map((i, n) => {
            const avail = stock[n];
            const def = avail == null ? i.quantity_requested : Math.max(0, Math.min(i.quantity_requested, avail));
            return `
            <div class="po-receive-row">
              <div style="flex:1">
                <div class="fw-600">${i.product_name}</div>
                <div style="font-size:12px;color:var(--text-muted)">${i.sku || ''}${i.sku ? ' · ' : ''}Requested: ${i.quantity_requested}${avail != null ? ` · In stock at ${t.from_branch_name}: <span class="${avail < i.quantity_requested ? 'color-danger fw-600' : ''}">${avail}</span>` : ''}</div>
              </div>
              <input id="tsend-${i.id}" type="number" min="0" step="1" value="${def}" style="width:80px" placeholder="Qty">
            </div>`;
          }).join('')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-danger" onclick="App.cancelTransfer(${t.id})">Cancel Request</button>
          <button class="btn btn-outline" onclick="App.printTransferPickList(${t.id})">🗒 Print Pick List</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-primary" id="tsend-btn" onclick="App.confirmSendTransfer(${t.id}, [${t.items.map(i => i.id).join(',')}])">Send</button>
        </div>
      </div>`);
  },

  // Pick list for the sending branch's inventory team: each item with its
  // bin location(s) there, sorted by bin so it can be walked in order, the
  // quantity to pick (asked while still a request, sent once sent), what's
  // in stock, and blank Picked boxes + sign-off lines. Once sent, the stock
  // (and bin counts) already exclude these units, so those are left off.
  async printTransferPickList(id) {
    const t = await this.api('GET', `/transfers/${id}`);
    const store = this.settings || {};
    const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const date = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const isRequest = t.status === 'requested';
    const qtyLabel = isRequest ? 'Requested' : 'Sent';
    const binText = i => i.bins.length ? i.bins.map(b => `${esc(b.bin_code)}${b.zone_name ? ` <span style="color:#777">(${esc(b.zone_name)})</span>` : ''}${isRequest && i.bins.length > 1 ? ` <span style="color:#777">· ${b.quantity}</span>` : ''}`).join('<br>') : '—';
    const lines = [...t.items].filter(i => isRequest || i.quantity_requested > 0)
      .sort((a, b) => (a.bins[0]?.bin_code ? 0 : 1) - (b.bins[0]?.bin_code ? 0 : 1) || String(a.bins[0]?.bin_code || '').localeCompare(String(b.bins[0]?.bin_code || ''), undefined, { numeric: true }) || a.product_name.localeCompare(b.product_name));
    const totalQty = lines.reduce((n, i) => n + (Number(i.quantity_requested) || 0), 0);
    const rows = lines.map(i => `
      <tr>
        <td>${binText(i)}</td>
        <td>${esc(i.product_name)}</td>
        <td>${esc(i.sku)}</td>
        <td style="text-align:center;font-weight:bold">${i.quantity_requested}</td>
        ${isRequest ? `<td style="text-align:center;${(i.source_stock ?? 0) < i.quantity_requested ? 'color:#c00;font-weight:bold' : ''}">${i.source_stock ?? 0}</td>` : ''}
        <td style="width:80px">&nbsp;</td>
      </tr>`).join('');
    const win = window.open('', '_blank', 'width=850,height=1000');
    win.document.write(`<!DOCTYPE html><html><head><title>Pick List – ${esc(t.transfer_number)}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:32px;color:#111}
      h1{font-size:20px;margin:0}h2{font-size:15px;font-weight:normal;margin:4px 0 0}
      .meta{display:flex;flex-wrap:wrap;gap:16px 40px;margin:16px 0 12px;font-size:12px}
      .meta div{line-height:1.6}
      .meta label{font-weight:bold;text-transform:uppercase;font-size:10px;color:#555;display:block}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      th{background:#f0f0f0;text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;border:1px solid #ccc}
      td{padding:6px 8px;border:1px solid #ddd;vertical-align:middle}
      tr:nth-child(even) td{background:#fafafa}
      .sign{display:flex;gap:40px;margin-top:36px;font-size:12px}
      .sign div{flex:1;border-top:1px solid #333;padding-top:4px}
      .footer{margin-top:24px;font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:8px}
      @media print{body{margin:16px}}
    </style></head><body>
    ${this._printLogoTag(50)}
    <h1>${esc(store.store_name || 'Pick List')}</h1>
    <h2>TRANSFER PICK LIST</h2>
    <div class="meta">
      <div><label>Transfer #</label>${esc(t.transfer_number)}</div>
      <div><label>Pick From</label>${esc(t.from_branch_name || '—')}</div>
      <div><label>Deliver To</label>${esc(t.to_branch_name || '—')}</div>
      <div><label>Requested</label>${this.fmtDate(t.created_at)}${t.employee_name ? ` · ${esc(t.employee_name)}` : ''}</div>
      ${t.sent_at ? `<div><label>Sent</label>${this.fmtDate(t.sent_at)}${t.sent_by_name ? ` · ${esc(t.sent_by_name)}` : ''}</div>` : ''}
      <div><label>Status</label>${esc(this._transferStatusLabel(t.status))}</div>
    </div>
    ${t.notes ? `<p style="font-size:12px"><strong>Notes:</strong> ${esc(t.notes)}</p>` : ''}
    <table>
      <thead><tr><th>Bin Location</th><th>Product</th><th>SKU</th><th>${qtyLabel}</th>${isRequest ? '<th>In Stock</th>' : ''}<th>Picked ✓</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sign"><div>Picked by</div><div>Checked by</div><div>Date</div></div>
    <div class="footer">Printed: ${date} &nbsp;|&nbsp; ${lines.length} item(s), ${totalQty} unit(s)</div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
    win.document.close();
  },

  async confirmSendTransfer(transferId, itemIds) {
    const items = itemIds.map(id => ({ item_id: id, quantity: parseInt(document.getElementById(`tsend-${id}`).value) || 0 }));
    if (!items.some(i => i.quantity > 0)) { this.alert('Enter a quantity for at least one item, or cancel the request', 'error'); return; }
    // A paid customer order: sending less leaves the customer short — say so.
    const t = this._sendingTransfer;
    if (t && t.id === transferId && this._isCustomerOrderTransfer(t)) {
      const short = items.map(i => ({ i, line: t.items.find(l => l.id === i.item_id) }))
        .filter(x => x.line && x.i.quantity < x.line.quantity_requested)
        .map(x => `• ${x.line.product_name}: the customer has paid for ${x.line.quantity_requested}; sending ${x.i.quantity} leaves them ${x.line.quantity_requested - x.i.quantity} short`);
      if (short.length && !confirm(`This is a paid customer order (sale ${t.sale_number}${t.sale_customer_name ? `, ${t.sale_customer_name}` : ''}).\n\n${short.join('\n')}\n\nThe branch selling it will see it as short and can refund the rest. Send anyway?`)) return;
    }
    const btn = document.getElementById('tsend-btn');
    if (btn) btn.disabled = true;
    try {
      await this.api('PATCH', `/transfers/${transferId}/send`, { items });
      this.closeModal();
      this.alert('Transfer sent — stock taken from the sending branch; the receiving branch can now receive it');
      this._refreshTransferView();
    } catch(e) { if (btn) btn.disabled = false; this.alert(e.message, 'error'); }
  },

  // A transfer raised for a paid POS sale (sell now, collect later —
  // lib/saleTransfers.js), while that sale stands.
  _isCustomerOrderTransfer(t) { return !!(t && t.transaction_id && t.sale_status === 'completed'); },
  _transferCustomerOrderBadge(t) {
    if (!this._isCustomerOrderTransfer(t)) return '';
    return ` <span class="badge-pill badge-purple" style="font-size:10px" title="Sale ${this.escapeAttr(t.sale_number)}${t.sale_customer_name ? ` · ${this.escapeAttr(t.sale_customer_name)}` : ''} — the customer has paid and collects at ${this.escapeAttr(t.to_branch_name || 'the receiving branch')}">Customer order — paid</span>`
      + `<div style="font-size:11px;color:var(--text-muted);font-weight:400">${this.escapeAttr(t.sale_number)}${t.sale_customer_name ? ` · ${this.escapeAttr(t.sale_customer_name)}` : ''}</div>`;
  },
  _transferCustomerOrderBanner(t) {
    if (!this._isCustomerOrderTransfer(t)) return '';
    return `<div style="border:2px solid #7c3aed;background:rgba(124,58,237,.07);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:13px">
      <span class="badge-pill badge-purple" style="font-size:10px">Customer order — paid</span>
      <strong>Sale ${this.escapeAttr(t.sale_number)}</strong>${t.sale_customer_name ? ` · ${this.escapeAttr(t.sale_customer_name)}` : ''}<br>
      The customer has already paid for these and collects them at <strong>${this.escapeAttr(t.to_branch_name || 'the receiving branch')}</strong>. Send everything requested if you can — anything you don't send leaves them short.</div>`;
  },

  async showReceiveTransfer(id) {
    const [t, people] = await Promise.all([this.api('GET', `/transfers/${id}`), this._transferPeople()]);
    if (t.status === 'requested') { this.alert('This transfer has not been sent yet', 'warning'); return; }
    const pending = t.items.filter(i => (i.quantity_received||0) < i.quantity_requested);
    if (!pending.length) { this.alert('All items already received', 'warning'); return; }
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><span class="modal-title">Receive Transfer — ${t.transfer_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:10px">Receiving at: <strong>${t.to_branch_name}</strong></p>
          <div class="input-row">
            <div class="form-group"><label>Delivered by *</label>${this._carrierPickerHtml('trecv-by', people, { id: t.driver_id, name: t.driver_name || '' })}</div>
            <div class="form-group"><label>Received by</label><input value="${this.escapeAttr(this.currentUser ? `${this.currentUser.first_name} ${this.currentUser.last_name}` : '')}" disabled title="Recorded as the person signed in"></div>
          </div>
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Enter quantities received. Branch inventory will be updated automatically.</p>
          ${pending.map(i => `
            <div class="po-receive-row">
              <div style="flex:1">
                <div class="fw-600">${i.product_name}</div>
                <div style="font-size:12px;color:var(--text-muted)">Sent: ${i.quantity_requested} | Received: ${i.quantity_received||0} | Pending: ${i.quantity_requested-(i.quantity_received||0)}</div>
              </div>
              <input id="trecv-${i.id}" type="number" min="0" max="${i.quantity_requested-(i.quantity_received||0)}" value="${i.quantity_requested-(i.quantity_received||0)}" style="width:80px" placeholder="Qty">
            </div>`).join('')}
          <div class="form-group" style="margin-top:10px"><label>Notes</label><input id="trecv-notes" placeholder="Optional — e.g. one box damaged"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-success" onclick="App.confirmReceiveTransfer(${t.id}, [${pending.map(i=>i.id).join(',')}])">Confirm Receipt</button>
        </div>
      </div>`);
  },

  async confirmReceiveTransfer(transferId, itemIds) {
    const items = itemIds.map(id => ({ item_id: id, quantity_received: parseInt(document.getElementById(`trecv-${id}`).value) || 0 })).filter(i => i.quantity_received > 0);
    if (!items.length) { this.alert('Enter at least one quantity', 'error'); return; }
    const by = this._readCarrier('trecv-by');
    if (!by.id && !by.name) { this.alert('Choose who delivered the items', 'error'); return; }
    try {
      await this.api('PATCH', `/transfers/${transferId}/receive`, { items, delivered_by_id: by.id || null, delivered_by_name: by.name || null, notes: document.getElementById('trecv-notes')?.value.trim() || null });
      this.closeModal();
      this.alert('Items received — destination branch inventory updated');
      this._refreshTransferView();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Branch Transfer Dispatch (Dispatch hub tile) ──────────────────────
  // Driver-facing view of transfers still moving between branches — same
  // underlying data/actions as the Warehouse "Branch Transfers" screen, just
  // framed as "Picked Up" (dispatch) / "Dropped Off" (receive) and limited
  // to jobs that still need one of those two things done.

  async renderTransferDispatch() {
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Branch Transfer Dispatch</h2>
      </div>
      <div id="transfer-dispatch-content"></div>`;
    await this.loadTransferDispatch();
  },

  async loadTransferDispatch() {
    const el = document.getElementById('transfer-dispatch-content');
    if (!el) return;
    const [pending, inTransit] = await Promise.all([
      this.api('GET', '/transfers?status=pending&limit=100'),
      this.api('GET', '/transfers?status=in_transit&limit=100'),
    ]);
    const transferList = [...pending, ...inTransit];
    if (!document.getElementById('transfer-dispatch-content')) return;
    const statusColor = { pending:'badge-warning', in_transit:'badge-info' };
    document.getElementById('transfer-dispatch-content').innerHTML = !transferList.length ? '<div class="empty-state"><p>No transfers awaiting pickup or drop-off.</p></div>' : `
      <table class="table">
        <thead><tr><th>Transfer #</th><th>From</th><th>To</th><th>Items</th><th>Status</th><th></th></tr></thead>
        <tbody>${transferList.map(t => `<tr>
          <td class="fw-600">${t.transfer_number}</td>
          <td>${t.from_branch_name||'—'}</td>
          <td>${t.to_branch_name||'—'}</td>
          <td style="max-width:260px">${t.item_summary||'—'}</td>
          <td><span class="badge-pill ${statusColor[t.status]||'badge-secondary'}">${this._transferStatusLabel(t.status)}</span>${t.driver_display_name ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">with ${this.escapeAttr(t.driver_display_name)}</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap">
            ${t.status==='pending' && this.can('transfers_pickup') ? `<button class="btn btn-sm btn-primary" onclick="App.dispatchTransfer(${t.id})">Picked Up</button>` : ''}
            ${(t.status==='pending'||t.status==='in_transit') && this.can('transfers_dropoff') ? `<button class="btn btn-sm btn-success" onclick="App.showReceiveTransfer(${t.id})">Dropped Off</button>` : ''}
            <button class="btn btn-sm btn-outline" onclick="App.viewTransfer(${t.id})">View</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>`;
  },

});
