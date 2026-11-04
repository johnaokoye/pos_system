// Shipping.
Object.assign(App, {
  // ─── SHIPPING ─────────────────────────────────────────────────────────────

  _shipTabs: [
    { key:'orders',    label:'Online Orders' },
    { key:'all',       label:'All' },
    { key:'draft',     label:'Draft' },
    { key:'shipped',   label:'Shipped' },
    { key:'delivered', label:'Delivered' },
    { key:'cancelled', label:'Cancelled' },
  ],

  async renderShipping() {
    this.shipFilter = this.shipFilter || 'all';
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Shipping</h2>
        <button class="btn btn-primary btn-sm" onclick="App.showShipmentModal()">+ New Shipment</button>
      </div>
      <div class="crm-tabs" id="ship-tabs-nav">
        ${this._shipTabs.map(t=>`
          <button class="crm-tab ${this.shipFilter===t.key?'active':''}" onclick="App.filterShipments('${t.key}')">${t.label}</button>`).join('')}
      </div>
      <div id="ship-list"></div>`;
    await this.loadShipmentsOrOrders();
  },

  async filterShipments(status) {
    this.shipFilter = status;
    document.querySelectorAll('#ship-tabs-nav .crm-tab').forEach((btn,i) => {
      btn.classList.toggle('active', this._shipTabs[i].key === status);
    });
    await this.loadShipmentsOrOrders();
  },

  async loadShipmentsOrOrders() {
    if (this.shipFilter === 'orders') return this.loadShipReadyOrders();
    return this.loadShipments();
  },

  async loadShipments() {
    const status = this.shipFilter==='all' ? '' : this.shipFilter;
    const shipments = await this.api('GET',`/warehouse/shipments${status?'?status='+status:''}`);
    const el = document.getElementById('ship-list');
    if (!el) return;
    const sc = { draft:'badge-secondary', shipped:'badge-info', delivered:'badge-success', cancelled:'badge-danger' };
    el.innerHTML = shipments.length===0 ? '<div class="empty-state"><p>No shipments found.</p></div>' : `
      <table class="table">
        <thead><tr><th>#</th><th>From</th><th>Customer</th><th>Carrier</th><th>Tracking</th><th>Ship Date</th><th>Items</th><th>Status</th><th></th></tr></thead>
        <tbody>${shipments.map(s=>`
          <tr>
            <td><strong>${s.shipment_number}</strong>${s.transaction_id?' <span class="badge badge-info" title="Linked to an online order">ORDER</span>':''}</td>
            <td>${s.from_branch_name||'—'}</td>
            <td>${s.customer_name||'—'}</td>
            <td>${s.carrier||'—'}</td>
            <td style="font-family:monospace;font-size:12px">${s.tracking_number||'—'}</td>
            <td>${s.ship_date?this.fmtDate(s.ship_date):'—'}</td>
            <td><span class="badge badge-info">${s.item_count}</span></td>
            <td><span class="badge ${sc[s.status]||'badge-secondary'}">${s.status}</span></td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-sm btn-outline" onclick="App.viewShipment(${s.id})">View</button>
              ${s.status==='draft'?`<button class="btn btn-sm btn-outline" onclick="App.printPickList(${s.id})" title="Print Pick List">🗒 Pick List</button>`:''}
              ${s.status!=='cancelled'?`<button class="btn btn-sm btn-outline" onclick="App.printShipLabel(${s.id})" title="Print Shipping Label">🏷 Label</button>`:''}
              ${s.status==='draft'?`<button class="btn btn-sm btn-primary" onclick="App.shipShipment(${s.id})">Ship</button>`:''}
              ${s.status==='shipped'?`<button class="btn btn-sm btn-success" onclick="App.deliverShipment(${s.id})">Delivered</button>`:''}
              ${s.status!=='delivered'&&s.status!=='cancelled'?`<button class="btn btn-sm btn-danger" onclick="App.cancelShipment(${s.id})">Cancel</button>`:''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  },

  async loadShipReadyOrders() {
    const el = document.getElementById('ship-list');
    if (!el) return;
    el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    const [orders, shipments] = await Promise.all([
      this.api('GET', '/transactions?source=online&fulfillment_status=processing&limit=200'),
      this.api('GET', '/warehouse/shipments'),
    ]);
    const shipByTx = {};
    shipments.forEach(s => { if (s.transaction_id) shipByTx[s.transaction_id] = s; });

    const el2 = document.getElementById('ship-list');
    if (!el2) return;
    el2.innerHTML = !orders.length ? `
      <div class="empty-state">
        <p>No online orders are currently marked "Processing".</p>
        <p style="font-size:13px;color:var(--text-muted)">Set an order's fulfillment status to "Processing" from the Online Orders page to have it show up here for shipment.</p>
      </div>` : `
      <table class="table">
        <thead><tr><th>Order #</th><th>Date</th><th>Customer</th><th>Branch</th><th>Total</th><th>Shipment</th><th></th></tr></thead>
        <tbody>${orders.map(o => {
          const ship = shipByTx[o.id];
          return `<tr>
            <td><strong>${o.transaction_number}</strong> <span class="badge badge-info" style="margin-left:4px">ONLINE</span></td>
            <td style="color:var(--text-muted)">${this.fmtDate(o.created_at)}</td>
            <td>${o.customer_name||'—'}</td>
            <td>${o.branch_name||'—'}</td>
            <td class="fw-600">${this.fmt(o.total)}</td>
            <td>${ship ? `<span class="badge badge-secondary">${ship.shipment_number}</span>` : '<span style="color:var(--text-muted);font-size:12px">Not yet processed</span>'}</td>
            <td style="text-align:right;white-space:nowrap">
              ${ship
                ? `<button class="btn btn-sm btn-outline" onclick="App.viewShipment(${ship.id})">View Shipment</button>`
                : `<button class="btn btn-sm btn-primary" onclick="App.showProcessOrderModal(${o.id})">Process for Shipping</button>`}
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  },

  async showProcessOrderModal(txId) {
    const order = await this.api('GET', `/transactions/${txId}`);
    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <span class="modal-title">Process Order ${order.transaction_number} for Shipping</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row" style="margin-bottom:10px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Customer</label><div>${order.customer_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Branch</label><div>${order.branch_name||'—'}</div></div>
          </div>
          <table class="table" style="margin-bottom:12px">
            <thead><tr><th>Product</th><th>SKU</th><th>Qty</th></tr></thead>
            <tbody>${order.items.map(i=>`<tr><td>${i.product_name}</td><td><span class="badge badge-secondary">${i.sku||'—'}</span></td><td>${i.quantity}</td></tr>`).join('')}</tbody>
          </table>
          <div class="input-row">
            <div class="form-group"><label>Carrier</label>
              <select id="po-carrier">
                <option value="">Select…</option>
                ${['UPS','FedEx','USPS','DHL','Local Delivery','Other'].map(c=>`<option>${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Tracking #</label>
              <input id="po-tracking" placeholder="Optional">
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Ship Date</label><input id="po-date" type="date"></div>
            <div class="form-group"><label>Est. Delivery</label><input id="po-estdel" type="date"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.processOrderForShipping(${txId})">Create Shipment</button>
        </div>
      </div>`);
  },

  async processOrderForShipping(txId) {
    const carrier = document.getElementById('po-carrier').value || null;
    const tracking_number = document.getElementById('po-tracking').value.trim() || null;
    const ship_date = document.getElementById('po-date').value || null;
    const estimated_delivery = document.getElementById('po-estdel').value || null;
    try {
      const ship = await this.api('POST', `/warehouse/shipments/from-order/${txId}`, { carrier, tracking_number, ship_date, estimated_delivery });
      this.closeModal();
      this.alert(`Shipment ${ship.shipment_number} created`);
      this.viewShipment(ship.id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showShipmentModal() {
    const [branches, products, bins] = await Promise.all([
      this.api('GET','/branches'),
      this.api('GET','/products'),
      this.api('GET','/warehouse/bins'),
    ]);
    this._shipProducts = products.filter(p=>p.active);
    this._shipBins = bins;
    this._shipLineIdx = 0;
    this.showModal(`
      <div class="modal" style="max-width:620px">
        <div class="modal-header">
          <span class="modal-title">New Shipment</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>From Location</label>
              <select id="sh-branch">
                <option value="">None</option>
                ${branches.map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Ship To (Customer)</label>
              ${this._customerPickerHtml('sh-cust', [], null, { emptyLabel: 'Walk-in / Other', remote: '' })}
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Carrier</label>
              <select id="sh-carrier">
                <option value="">Select…</option>
                ${['UPS','FedEx','USPS','DHL','Local Delivery','Other'].map(c=>`<option>${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Tracking #</label>
              <input id="sh-tracking" placeholder="Optional">
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Ship Date</label><input id="sh-date" type="date"></div>
            <div class="form-group"><label>Est. Delivery</label><input id="sh-estdel" type="date"></div>
          </div>
          <div class="form-group"><label>Notes</label>
            <textarea id="sh-notes" rows="2" placeholder="Optional…"></textarea>
          </div>
          <hr style="margin:12px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>Items</strong>
            <button class="btn btn-sm btn-outline" onclick="App.addShipLine()">+ Add Item</button>
          </div>
          <div id="ship-lines"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveShipment()">Create Draft</button>
        </div>
      </div>`);
    this.addShipLine();
    // Item lines are added dynamically (addShipLine), so this closes
    // whichever sh-prod-dd-* dropdown is currently open rather than
    // binding to a specific line's id — same pattern as the Quotation
    // item picker.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sh-prod-search-wrap')) {
        document.querySelectorAll('[id^="sh-prod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
      }
    });
  },

  addShipLine() {
    const container = document.getElementById('ship-lines');
    if (!container) return;
    const idx = this._shipLineIdx++;
    const bins = this._shipBins||[];
    const div = document.createElement('div');
    div.id = `ship-line-${idx}`;
    div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';
    div.innerHTML = `
      <span class="sh-prod-search-wrap" style="flex:2;position:relative">
        <input type="text" id="sh-prod-search-${idx}" placeholder="Search product…" autocomplete="off" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px"
          oninput="App._filterShipProdOptions(${idx},this.value)" onfocus="App._filterShipProdOptions(${idx},this.value)">
        <input type="hidden" id="sh-prod-${idx}" value="">
        <div id="sh-prod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
      </span>
      <input id="sh-qty-${idx}" type="number" min="1" value="1" style="width:60px;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px">
      <select id="sh-bin-${idx}" style="flex:1;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px">
        <option value="">No bin</option>
        ${bins.map(b=>`<option value="${b.id}">${b.bin_code}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('ship-line-${idx}').remove()">✕</button>`;
    container.appendChild(div);
  },

  // Searchable replacement for what used to be a plain <select> of every
  // active product — same pattern as the Quotation item picker.
  // saveShipment reads sh-prod-${idx}'s value directly (a hidden input
  // here, same id/semantics as the old select).
  _filterShipProdOptions(idx, query) {
    const dd = document.getElementById(`sh-prod-dd-${idx}`);
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._shipProducts || []).filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectShipProdOption(${idx},${p.id})">
        <strong>${p.name}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${p.sku||''}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No products found</div>`;
    dd.style.display = '';
  },

  _selectShipProdOption(idx, productId) {
    const p = (this._shipProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById(`sh-prod-${idx}`);
    const searchEl = document.getElementById(`sh-prod-search-${idx}`);
    const dd = document.getElementById(`sh-prod-dd-${idx}`);
    if (hidden) hidden.value = productId;
    if (searchEl) searchEl.value = `${p.name} (${p.sku||''})`;
    if (dd) dd.style.display = 'none';
  },

  async saveShipment() {
    const items = [];
    document.querySelectorAll('#ship-lines [id^="ship-line-"]').forEach(line => {
      const idx = line.id.replace('ship-line-','');
      const product_id = document.getElementById(`sh-prod-${idx}`)?.value;
      if (product_id) items.push({
        product_id,
        quantity:   parseInt(document.getElementById(`sh-qty-${idx}`)?.value)||1,
        bin_id:     document.getElementById(`sh-bin-${idx}`)?.value||null,
      });
    });
    if (!items.length) return this.alert('Add at least one item','error');
    const data = {
      from_branch_id:     document.getElementById('sh-branch').value||null,
      customer_id:        document.getElementById('sh-cust').value||null,
      carrier:            document.getElementById('sh-carrier').value||null,
      tracking_number:    document.getElementById('sh-tracking').value.trim()||null,
      ship_date:          document.getElementById('sh-date').value||null,
      estimated_delivery: document.getElementById('sh-estdel').value||null,
      notes:              document.getElementById('sh-notes').value.trim()||null,
      items,
    };
    try {
      await this.api('POST','/warehouse/shipments',data);
      this.alert('Shipment created as draft');
      this.closeModal();
      this.loadShipmentsOrOrders();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async viewShipment(id) {
    const s = await this.api('GET',`/warehouse/shipments/${id}`);
    const sc = { draft:'badge-secondary', shipped:'badge-info', delivered:'badge-success', cancelled:'badge-danger' };
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header">
          <span class="modal-title">${s.shipment_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            <span class="badge ${sc[s.status]||'badge-secondary'}" style="font-size:13px">${s.status.toUpperCase()}</span>
            ${s.order_number?`<span class="badge badge-info" style="font-size:13px" title="Linked online order">Order: ${s.order_number}</span>`:''}
            ${s.carrier?`<span style="font-size:13px">📦 ${s.carrier}</span>`:''}
            ${s.tracking_number?`<span style="font-family:monospace;font-size:12px;background:#f5f5f5;padding:2px 6px;border-radius:4px">${s.tracking_number}</span>`:''}
          </div>
          <div class="input-row" style="margin-bottom:10px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">From</label><div>${s.from_branch_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Customer</label><div>${s.customer_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Ship Date</label><div>${s.ship_date?this.fmtDate(s.ship_date):'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Est. Delivery</label><div>${s.estimated_delivery?this.fmtDate(s.estimated_delivery):'—'}</div></div>
          </div>
          ${s.notes?`<p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">${s.notes}</p>`:''}
          <table class="table" style="margin-bottom:0">
            <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>From Bin</th></tr></thead>
            <tbody>${s.items.map(i=>`<tr><td>${i.product_name}</td><td><span class="badge badge-secondary">${i.sku}</span></td><td>${i.quantity}</td><td>${i.bin_code||'—'}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="modal-footer">
          ${s.status==='draft'?`<button class="btn btn-outline" onclick="App.printPickList(${s.id})">🗒 Print Pick List</button>`:''}
          ${s.status!=='cancelled'?`<button class="btn btn-outline" onclick="App.printShipLabel(${s.id})">🏷 Print Label</button>`:''}
          ${s.status==='draft'?`<button class="btn btn-primary" onclick="App.shipShipment(${s.id})">Mark Shipped</button>`:''}
          ${s.status==='shipped'?`<button class="btn btn-success" onclick="App.deliverShipment(${s.id})">Mark Delivered</button>`:''}
          ${s.status!=='delivered'&&s.status!=='cancelled'?`<button class="btn btn-danger" onclick="App.cancelShipment(${s.id})">Cancel Shipment</button>`:''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async shipShipment(id) {
    const tracking = prompt('Tracking number (leave blank to keep existing):')||null;
    try {
      await this.api('PATCH',`/warehouse/shipments/${id}/ship`,{ tracking_number: tracking });
      this.alert('Shipped — inventory deducted');
      this.closeModal();
      this.loadShipmentsOrOrders();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async deliverShipment(id) {
    if (!confirm('Mark as delivered?')) return;
    try {
      await this.api('PATCH',`/warehouse/shipments/${id}/deliver`,{});
      this.alert('Marked as delivered');
      this.closeModal();
      this.loadShipmentsOrOrders();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async cancelShipment(id) {
    if (!confirm('Cancel shipment? Stock will be restored if already shipped.')) return;
    try {
      await this.api('PATCH',`/warehouse/shipments/${id}/cancel`,{});
      this.alert('Shipment cancelled');
      this.closeModal();
      this.loadShipmentsOrOrders();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async printPickList(id) {
    const s = await this.api('GET', `/warehouse/shipments/${id}`);
    const store = this.settings || {};
    const date = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const rows = s.items.map(i => `
      <tr>
        <td>${i.product_name}</td>
        <td>${i.sku}</td>
        <td style="text-align:center;font-weight:bold">${i.quantity}</td>
        <td>${i.bin_code || '—'}</td>
        <td style="width:80px;border-bottom:1px solid #999">&nbsp;</td>
      </tr>`).join('');
    const win = window.open('', '_blank', 'width=800,height=600');
    win.document.write(`<!DOCTYPE html><html><head><title>Pick List – ${s.shipment_number}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:32px;color:#111}
      h1{font-size:20px;margin:0}h2{font-size:15px;font-weight:normal;margin:4px 0 0}
      .meta{display:flex;gap:40px;margin:16px 0 12px;font-size:12px}
      .meta div{line-height:1.6}
      .meta label{font-weight:bold;text-transform:uppercase;font-size:10px;color:#555;display:block}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      th{background:#f0f0f0;text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;border:1px solid #ccc}
      td{padding:6px 8px;border:1px solid #ddd;vertical-align:middle}
      tr:nth-child(even) td{background:#fafafa}
      .footer{margin-top:24px;font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:8px}
      @media print{body{margin:16px}}
    </style></head><body>
    ${this._printLogoTag(50)}
    <h1>${store.store_name || 'Pick List'}</h1>
    <h2>PICK LIST</h2>
    <div class="meta">
      <div><label>Shipment #</label>${s.shipment_number}</div>
      <div><label>Date</label>${date}</div>
      <div><label>From</label>${s.from_branch_name || '—'}</div>
      <div><label>Customer</label>${s.customer_name || '—'}</div>
      ${s.carrier ? `<div><label>Carrier</label>${s.carrier}</div>` : ''}
    </div>
    <table>
      <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>Bin Location</th><th>Picked ✓</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${s.notes ? `<p style="margin-top:12px;font-size:12px"><strong>Notes:</strong> ${s.notes}</p>` : ''}
    <div class="footer">Printed: ${date} &nbsp;|&nbsp; ${s.item_count || s.items.length} item(s)</div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
    win.document.close();
  },

  async printShipLabel(id) {
    const s = await this.api('GET', `/warehouse/shipments/${id}`);
    const store = this.settings || {};
    const fromLines = [
      s.from_branch_name || store.store_name || '',
      s.from_branch_address || store.address || '',
      [s.from_branch_city, s.from_branch_state, s.from_branch_zip].filter(Boolean).join(', '),
      s.from_branch_phone || store.phone || '',
    ].filter(Boolean);
    const toLines = [
      s.customer_name || 'Walk-in / Other',
      s.customer_address || '',
      [s.customer_city, s.customer_state, s.customer_zip].filter(Boolean).join(', '),
      s.customer_phone || '',
      s.customer_email || '',
    ].filter(Boolean);
    const win = window.open('', '_blank', 'width=600,height=500');
    win.document.write(`<!DOCTYPE html><html><head><title>Shipping Label – ${s.shipment_number}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:Arial,sans-serif;font-size:14px;margin:0;padding:24px;color:#111}
      .label{border:2px solid #111;width:100%;max-width:500px;margin:0 auto;padding:0}
      .label-header{background:#111;color:#fff;padding:8px 14px;display:flex;justify-content:space-between;align-items:center;font-size:12px}
      .label-header strong{font-size:16px}
      .addr-section{display:flex;border-bottom:2px solid #111}
      .addr-block{flex:1;padding:14px}
      .addr-block+.addr-block{border-left:2px solid #111}
      .addr-label{font-size:9px;font-weight:bold;text-transform:uppercase;color:#555;margin-bottom:6px}
      .addr-name{font-size:16px;font-weight:bold;margin-bottom:4px}
      .addr-line{font-size:13px;line-height:1.5;color:#333}
      .carrier-row{display:flex;gap:0;border-bottom:2px solid #111}
      .carrier-cell{flex:1;padding:10px 14px;border-right:2px solid #111}
      .carrier-cell:last-child{border-right:none}
      .carrier-cell label{font-size:9px;font-weight:bold;text-transform:uppercase;color:#555;display:block;margin-bottom:3px}
      .carrier-cell span{font-size:14px;font-weight:bold}
      .barcode-row{padding:12px 14px;text-align:center}
      .shipnum{font-family:monospace;font-size:22px;font-weight:bold;letter-spacing:3px;border:1px solid #ccc;padding:6px 14px;display:inline-block}
      @media print{body{padding:8px}.label{max-width:100%}}
    </style></head><body>
    <div class="label">
      <div class="label-header">
        <span>SHIPPING LABEL</span>
        <strong>${s.carrier || 'CARRIER'}</strong>
        <span>${new Date().toLocaleDateString()}</span>
      </div>
      <div class="addr-section">
        <div class="addr-block">
          <div class="addr-label">FROM</div>
          <div class="addr-name">${fromLines[0] || '—'}</div>
          ${fromLines.slice(1).map(l=>`<div class="addr-line">${l}</div>`).join('')}
        </div>
        <div class="addr-block">
          <div class="addr-label">SHIP TO</div>
          <div class="addr-name">${toLines[0] || '—'}</div>
          ${toLines.slice(1).map(l=>`<div class="addr-line">${l}</div>`).join('')}
        </div>
      </div>
      <div class="carrier-row">
        <div class="carrier-cell"><label>Tracking #</label><span>${s.tracking_number || '—'}</span></div>
        <div class="carrier-cell"><label>Ship Date</label><span>${s.ship_date || '—'}</span></div>
        <div class="carrier-cell"><label>Est. Delivery</label><span>${s.estimated_delivery || '—'}</span></div>
      </div>
      <div class="barcode-row">
        <div class="shipnum">${s.shipment_number}</div>
        <div style="font-size:11px;color:#777;margin-top:6px">${s.items ? s.items.length : ''} item(s)</div>
      </div>
    </div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
    win.document.close();
  },

});
