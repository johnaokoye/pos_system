// Warehouse management.
Object.assign(App, {
  // ─── WAREHOUSE MANAGEMENT ─────────────────────────────────────────────────

  async renderWarehouse() {
    this.warehouseTab = this.warehouseTab || 'locations';
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Warehouse Management</h2>
        <div id="wh-header-actions"></div>
      </div>
      <div class="crm-tabs" id="wh-tabs-nav">
        <button class="crm-tab" onclick="App.switchWhTab('locations')">Locations</button>
        <button class="crm-tab" onclick="App.switchWhTab('zones')">Zones</button>
        <button class="crm-tab" onclick="App.switchWhTab('bins')">Bins</button>
        <button class="crm-tab" onclick="App.switchWhTab('assignments')">Product Assignments</button>
      </div>
      <div id="wh-tab-content"></div>`;
    document.querySelectorAll('#wh-tabs-nav .crm-tab').forEach((btn,i) => {
      const tabs = ['locations','zones','bins','assignments'];
      btn.classList.toggle('active', tabs[i] === this.warehouseTab);
    });
    await this.renderWhTab();
  },

  switchWhTab(tab) {
    this.warehouseTab = tab;
    document.querySelectorAll('#wh-tabs-nav .crm-tab').forEach((btn,i) => {
      const tabs = ['locations','zones','bins','assignments'];
      btn.classList.toggle('active', tabs[i] === tab);
    });
    this.renderWhTab();
  },

  async renderWhTab() {
    const el = document.getElementById('wh-tab-content');
    const hdr = document.getElementById('wh-header-actions');
    if (!el) return;
    if (this.warehouseTab === 'locations') {
      if (hdr) hdr.innerHTML = '';
      await this.renderWhLocations(el);
    } else if (this.warehouseTab === 'zones') {
      if (hdr) hdr.innerHTML = '<button class="btn btn-primary btn-sm" onclick="App.showZoneModal()">+ New Zone</button>';
      await this.renderWhZones(el);
    } else if (this.warehouseTab === 'bins') {
      if (hdr) hdr.innerHTML = '<button class="btn btn-primary btn-sm" onclick="App.showBinModal()">+ New Bin</button>';
      await this.renderWhBins(el);
    } else if (this.warehouseTab === 'assignments') {
      if (hdr) hdr.innerHTML = '<button class="btn btn-primary btn-sm" onclick="App.showAssignmentModal()">+ Assign Product</button>';
      await this.renderWhAssignments(el);
    }
  },

  async renderWhLocations(el) {
    const branches = await this.api('GET', '/branches');
    const whCount = branches.filter(b => b.is_warehouse).length;
    el.innerHTML = `
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">Any active location — store or warehouse — can have zones (e.g. aisles) and bins (e.g. shelves) set up in the Zones and Bins tabs. Marking a branch as a "Warehouse" below only affects sales reporting (it's excluded from Dashboard/Reports sales figures), not bin management.</p>
      ${whCount > 0
        ? `<div style="margin-bottom:12px;padding:8px 14px;background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;border-radius:4px;font-size:13px;color:#3b82f6">
            🏭 ${whCount} warehouse location${whCount>1?'s':''} excluded from sales reporting.
           </div>`
        : ''}
      <table class="table">
        <thead><tr><th>Code</th><th>Name</th><th>City / State</th><th>Manager</th><th>Type</th><th></th></tr></thead>
        <tbody>${branches.map(b => `
          <tr style="${b.is_warehouse?'background:rgba(59,130,246,0.05);border-left:3px solid #3b82f6':''}">
            <td><span class="badge badge-secondary">${b.branch_code}</span></td>
            <td><strong>${b.name}</strong>${b.is_warehouse?' <span title="Warehouse branch" style="margin-left:4px">🏭</span>':''}</td>
            <td style="color:var(--text-muted)">${[b.city,b.state].filter(Boolean).join(', ')||'—'}</td>
            <td>${b.manager||'—'}</td>
            <td><span class="badge ${b.is_warehouse?'badge-info':'badge-secondary'}">${b.is_warehouse?'✓ Warehouse':'Retail'}</span></td>
            <td style="text-align:right">
              <button class="btn btn-sm ${b.is_warehouse?'btn-danger':'btn-primary'}" onclick="App.toggleWarehouse(${b.id},${b.is_warehouse?0:1})">
                ${b.is_warehouse?'Remove Warehouse':'Mark as Warehouse'}
              </button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  },

  async toggleWarehouse(id, val) {
    const branch = await this.api('GET', `/branches/${id}`);
    try {
      await this.api('PUT', `/branches/${id}`, { ...branch, is_warehouse: val });
      this.alert(val ? `"${branch.name}" marked as warehouse` : `Warehouse flag removed from "${branch.name}"`);
      this.renderWhTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async renderWhZones(el) {
    const [zones, branches] = await Promise.all([
      this.api('GET', '/warehouse/zones'),
      this.api('GET', '/branches'),
    ]);
    this._whBranches = branches;
    const activeBranches = branches.filter(b => b.active);
    el.innerHTML = `
      ${activeBranches.length === 0 ? `<div style="margin-bottom:12px;padding:8px 14px;background:rgba(245,158,11,0.08);border-left:3px solid #d97706;border-radius:4px;font-size:13px;color:#d97706">
        No active locations configured. Go to the <strong>Locations</strong> tab to add one first.
      </div>` : ''}
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
        <label style="font-size:13px;color:var(--text-muted)">Filter by location:</label>
        <select id="zone-filter-branch" onchange="App.filterZones()" style="width:200px">
          <option value="">All Locations</option>
          ${activeBranches.map(b=>`<option value="${b.id}">${b.name}${b.is_warehouse?' 🏭':''}</option>`).join('')}
        </select>
      </div>
      <table class="table">
        <thead><tr><th>Code</th><th>Zone Name</th><th>Location</th><th>Bins</th><th>Description</th><th></th></tr></thead>
        <tbody id="zones-tbody">${this._renderZoneRows(zones)}</tbody>
      </table>
      ${zones.length===0?'<div class="empty-state"><p>No zones yet. Create zones to organise storage areas (e.g. aisles) within a location.</p></div>':''}`;
  },

  _renderZoneRows(zones) {
    if (!zones.length) return '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No zones found</td></tr>';
    return zones.map(z => `
      <tr>
        <td>${z.code?`<span class="badge badge-secondary">${z.code}</span>`:'—'}</td>
        <td><strong>${z.name}</strong></td>
        <td>${z.branch_name||'—'}</td>
        <td><span class="badge badge-info">${z.bin_count} bins</span></td>
        <td style="color:var(--text-muted)">${z.description||'—'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm btn-outline" onclick='App.showZoneModal(${JSON.stringify(z)})'>Edit</button>
          <button class="btn btn-sm btn-danger" onclick="App.deleteZone(${z.id})">Delete</button>
        </td>
      </tr>`).join('');
  },

  async filterZones() {
    const branchId = document.getElementById('zone-filter-branch')?.value;
    const zones = await this.api('GET', `/warehouse/zones${branchId?'?branch_id='+branchId:''}`);
    const tbody = document.getElementById('zones-tbody');
    if (tbody) tbody.innerHTML = this._renderZoneRows(zones);
  },

  showZoneModal(zone) {
    const branches = (this._whBranches || []).filter(b => b.active);
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <span class="modal-title">${zone?'Edit Zone':'New Zone'}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          ${branches.length===0?'<div style="padding:8px 12px;background:rgba(245,158,11,0.1);border-radius:4px;color:#d97706;font-size:13px;margin-bottom:12px">No active locations found. Add a branch first.</div>':''}
          <div class="input-row">
            <div class="form-group"><label>Location *</label>
              <select id="z-branch">
                <option value="">Select location…</option>
                ${branches.map(b=>`<option value="${b.id}" ${zone&&zone.branch_id==b.id?'selected':''}>${b.name}${b.is_warehouse?' 🏭':''}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Zone Code</label>
              <input id="z-code" placeholder="e.g. A" value="${zone&&zone.code?zone.code:''}">
            </div>
          </div>
          <div class="form-group"><label>Zone Name *</label>
            <input id="z-name" placeholder="e.g. Aisle 3, Receiving Area" value="${zone?zone.name:''}">
          </div>
          <div class="form-group"><label>Description</label>
            <input id="z-desc" placeholder="Optional" value="${zone&&zone.description?zone.description:''}">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveZone(${zone?zone.id:'null'})">Save Zone</button>
        </div>
      </div>`);
  },

  async saveZone(id) {
    const data = {
      branch_id:   document.getElementById('z-branch').value,
      code:        document.getElementById('z-code').value.trim()||null,
      name:        document.getElementById('z-name').value.trim(),
      description: document.getElementById('z-desc').value.trim()||null,
    };
    if (!data.branch_id||!data.name) return this.alert('Location and name required','error');
    try {
      if (id) await this.api('PUT',`/warehouse/zones/${id}`,data);
      else    await this.api('POST','/warehouse/zones',data);
      this.alert(id?'Zone updated':'Zone created');
      this.closeModal();
      this.renderWhTab();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async deleteZone(id) {
    if (!confirm('Delete this zone? All bins must be removed first.')) return;
    try {
      await this.api('DELETE',`/warehouse/zones/${id}`);
      this.alert('Zone deleted');
      this.renderWhTab();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async renderWhBins(el) {
    const [bins, zones, branches] = await Promise.all([
      this.api('GET','/warehouse/bins'),
      this.api('GET','/warehouse/zones'),
      this.api('GET','/branches'),
    ]);
    this._whZones = zones;
    this._whBranches = branches;
    const activeBranches = branches.filter(b => b.active);
    el.innerHTML = `
      ${activeBranches.length === 0 ? `<div style="margin-bottom:12px;padding:8px 14px;background:rgba(245,158,11,0.08);border-left:3px solid #d97706;border-radius:4px;font-size:13px;color:#d97706">
        No active locations configured. Go to the <strong>Locations</strong> tab to add one first.
      </div>` : ''}
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label style="font-size:13px;color:var(--text-muted)">Filter:</label>
        <select id="bin-filter-branch" onchange="App.filterBins()" style="width:175px">
          <option value="">All Locations</option>
          ${activeBranches.map(b=>`<option value="${b.id}">${b.name}${b.is_warehouse?' 🏭':''}</option>`).join('')}
        </select>
        <select id="bin-filter-zone" onchange="App.filterBins()" style="width:175px">
          <option value="">All Zones</option>
          ${zones.map(z=>`<option value="${z.id}">${z.name} (${z.branch_name})</option>`).join('')}
        </select>
      </div>
      <table class="table">
        <thead><tr><th>Bin Code</th><th>Zone</th><th>Location</th><th>Description</th><th>Capacity</th><th>Products</th><th>Status</th><th></th></tr></thead>
        <tbody id="bins-tbody">${this._renderBinRows(bins)}</tbody>
      </table>
      ${bins.length===0?'<div class="empty-state"><p>No bins yet. Add zones first, then create bins within them.</p></div>':''}`;
  },

  _renderBinRows(bins) {
    if (!bins.length) return '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">No bins found</td></tr>';
    return bins.map(b=>`
      <tr>
        <td><strong>${b.bin_code}</strong></td>
        <td>${b.zone_name||'—'}</td>
        <td>${b.branch_name||'—'}</td>
        <td style="color:var(--text-muted)">${b.description||'—'}</td>
        <td>${b.capacity||'—'}</td>
        <td><span class="badge badge-info">${b.assignment_count}</span></td>
        <td><span class="badge ${b.active?'badge-success':'badge-secondary'}">${b.active?'Active':'Inactive'}</span></td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm btn-outline" onclick='App.showBinModal(${JSON.stringify(b)})'>Edit</button>
          <button class="btn btn-sm btn-danger" onclick="App.deleteBin(${b.id})">Delete</button>
        </td>
      </tr>`).join('');
  },

  async filterBins() {
    const branchId = document.getElementById('bin-filter-branch')?.value;
    const zoneId   = document.getElementById('bin-filter-zone')?.value;
    let url = '/warehouse/bins?';
    if (branchId) url += `branch_id=${branchId}&`;
    if (zoneId)   url += `zone_id=${zoneId}&`;
    const bins = await this.api('GET', url);
    const tbody = document.getElementById('bins-tbody');
    if (tbody) tbody.innerHTML = this._renderBinRows(bins);
  },

  showBinModal(bin) {
    const zones    = this._whZones    || [];
    const branches = (this._whBranches || []).filter(b => b.active);
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <span class="modal-title">${bin?'Edit Bin':'New Bin'}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>Bin Code *</label>
              <input id="b-code" placeholder="e.g. Aisle3-Shelf2-BinA" value="${bin?bin.bin_code:''}">
            </div>
            <div class="form-group"><label>Capacity</label>
              <input id="b-cap" type="number" min="0" placeholder="Max units" value="${bin&&bin.capacity?bin.capacity:''}">
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Zone</label>
              <select id="b-zone">
                <option value="">No Zone</option>
                ${zones.map(z=>`<option value="${z.id}" ${bin&&bin.zone_id==z.id?'selected':''}>${z.name} — ${z.branch_name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Location</label>
              <select id="b-branch">
                <option value="">No Location</option>
                ${branches.map(br=>`<option value="${br.id}" ${bin&&bin.branch_id==br.id?'selected':''}>${br.name}${br.is_warehouse?' 🏭':''}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group"><label>Description</label>
            <input id="b-desc" placeholder="Optional" value="${bin&&bin.description?bin.description:''}">
          </div>
          ${bin?`<div class="form-group"><label>Status</label>
            <select id="b-active">
              <option value="1" ${bin.active?'selected':''}>Active</option>
              <option value="0" ${!bin.active?'selected':''}>Inactive</option>
            </select></div>`:''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveBin(${bin?bin.id:'null'})">Save Bin</button>
        </div>
      </div>`);
  },

  async saveBin(id) {
    const data = {
      bin_code:    document.getElementById('b-code').value.trim(),
      zone_id:     document.getElementById('b-zone').value||null,
      branch_id:   document.getElementById('b-branch').value||null,
      description: document.getElementById('b-desc').value.trim()||null,
      capacity:    document.getElementById('b-cap').value||null,
      active:      document.getElementById('b-active') ? parseInt(document.getElementById('b-active').value) : 1,
    };
    if (!data.bin_code) return this.alert('Bin code required','error');
    try {
      if (id) await this.api('PUT',`/warehouse/bins/${id}`,data);
      else    await this.api('POST','/warehouse/bins',data);
      this.alert(id?'Bin updated':'Bin created');
      this.closeModal();
      this.renderWhTab();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async deleteBin(id) {
    if (!confirm('Delete this bin? Remove all product assignments first.')) return;
    try {
      await this.api('DELETE',`/warehouse/bins/${id}`);
      this.alert('Bin deleted');
      this.renderWhTab();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async renderWhAssignments(el) {
    const [assignments, bins, branches] = await Promise.all([
      this.api('GET','/warehouse/assignments'),
      this.api('GET','/warehouse/bins'),
      this.api('GET','/branches'),
    ]);
    this._whBins     = bins;
    this._whBranches = branches;
    el.innerHTML = `
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label style="font-size:13px;color:var(--text-muted)">Filter by bin:</label>
        <select id="asn-filter-bin" onchange="App.filterAssignments()" style="width:220px">
          <option value="">All Bins</option>
          ${bins.map(b=>`<option value="${b.id}">${b.bin_code}${b.zone_name?' — '+b.zone_name:''}</option>`).join('')}
        </select>
      </div>
      <table class="table">
        <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th>Bin</th><th>Zone</th><th>Qty in Bin</th><th>Total Stock</th><th>Primary</th><th></th></tr></thead>
        <tbody id="asn-tbody">${this._renderAsnRows(assignments)}</tbody>
      </table>
      ${assignments.length===0?'<div class="empty-state"><p>No bin assignments yet. Use "+ Assign Product" to place products into bins.</p></div>':''}`;
  },

  _renderAsnRows(rows) {
    if (!rows.length) return '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">No assignments found</td></tr>';
    return rows.map(a=>`
      <tr>
        <td><strong>${a.product_name}</strong></td>
        <td><span class="badge badge-secondary">${a.sku}</span></td>
        <td style="color:var(--text-muted)">${a.category_name||'—'}</td>
        <td><strong>${a.bin_code}</strong></td>
        <td>${a.zone_name||'—'}</td>
        <td>
          <input type="number" min="0" value="${a.quantity}" onchange="App.updateAssignmentQty(${a.id},this.value)"
            style="width:70px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:13px">
        </td>
        <td>${a.total_stock}</td>
        <td>${a.is_primary?'<span class="badge badge-success">Primary</span>':''}</td>
        <td style="text-align:right">
          <button class="btn btn-sm btn-danger" onclick="App.deleteAssignment(${a.id})">Remove</button>
        </td>
      </tr>`).join('');
  },

  async filterAssignments() {
    const binId = document.getElementById('asn-filter-bin')?.value;
    const rows  = await this.api('GET',`/warehouse/assignments${binId?'?bin_id='+binId:''}`);
    const tbody = document.getElementById('asn-tbody');
    if (tbody) tbody.innerHTML = this._renderAsnRows(rows);
  },

  async updateAssignmentQty(id, qty) {
    try {
      await this.api('PUT',`/warehouse/assignments/${id}`,{ quantity: parseInt(qty)||0 });
    } catch(e) { this.alert(e.message,'error'); }
  },

  async showAssignmentModal() {
    const [products, bins] = await Promise.all([
      this.api('GET','/products'),
      this.api('GET','/warehouse/bins'),
    ]);
    this._whBins = bins;
    this._asnProducts = products.filter(p=>p.active);
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <span class="modal-title">Assign Product to Bin</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group asn-prod-search-wrap" style="position:relative"><label>Product *</label>
            <input type="text" id="asn-prod-search" placeholder="Search product…" autocomplete="off"
              oninput="App._filterAsnProdOptions(this.value)" onfocus="App._filterAsnProdOptions(this.value)">
            <input type="hidden" id="asn-prod" value="">
            <div id="asn-prod-dd" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
          </div>
          <div class="form-group"><label>Bin *</label>
            <select id="asn-bin">
              <option value="">Select bin…</option>
              ${bins.map(b=>`<option value="${b.id}">${b.bin_code}${b.zone_name?' — '+b.zone_name:''}${b.branch_name?' ['+b.branch_name+']':''}</option>`).join('')}
            </select>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Qty in Bin</label>
              <input id="asn-qty" type="number" min="0" value="0">
            </div>
            <div class="form-group"><label>Primary Bin?</label>
              <select id="asn-primary"><option value="0">No</option><option value="1">Yes</option></select>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveAssignment()">Assign</button>
        </div>
      </div>`);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.asn-prod-search-wrap')) {
        const dd = document.getElementById('asn-prod-dd');
        if (dd) dd.style.display = 'none';
      }
    });
  },

  // Searchable replacement for what used to be a plain <select> of every
  // active product — same pattern as the Quotation item picker.
  // saveAssignment reads asn-prod's value directly (a hidden input here,
  // same id/semantics as the old select).
  _filterAsnProdOptions(query) {
    const dd = document.getElementById('asn-prod-dd');
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._asnProducts || []).filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectAsnProdOption(${p.id})">
        <strong>${p.name}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${p.sku||''}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No products found</div>`;
    dd.style.display = '';
  },

  _selectAsnProdOption(productId) {
    const p = (this._asnProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById('asn-prod');
    const searchEl = document.getElementById('asn-prod-search');
    const dd = document.getElementById('asn-prod-dd');
    if (hidden) hidden.value = productId;
    if (searchEl) searchEl.value = `${p.name} (${p.sku||''})`;
    if (dd) dd.style.display = 'none';
  },

  async saveAssignment() {
    const binId = document.getElementById('asn-bin').value;
    const selectedBin = (this._whBins || []).find(b => String(b.id) === binId);
    const data = {
      product_id: document.getElementById('asn-prod').value,
      bin_id:     binId,
      branch_id:  selectedBin?.branch_id || null,
      quantity:   parseInt(document.getElementById('asn-qty').value)||0,
      is_primary: document.getElementById('asn-primary').value==='1',
    };
    if (!data.product_id||!data.bin_id) return this.alert('Product and bin required','error');
    try {
      await this.api('POST','/warehouse/assignments',data);
      this.alert('Product assigned to bin');
      this.closeModal();
      this.renderWhTab();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async deleteAssignment(id) {
    if (!confirm('Remove this product from the bin?')) return;
    try {
      await this.api('DELETE',`/warehouse/assignments/${id}`);
      this.alert('Assignment removed');
      this.renderWhTab();
    } catch(e) { this.alert(e.message,'error'); }
  },

});
