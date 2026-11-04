// Retail inventory, product form, catalogues, bins, services and non-inventory items, stock adjust and bulk tools.
Object.assign(App, {
  // ─── Inventory ────────────────────────────────────────────
  // Inventory filter bar as it stands, so a save / stock change can re-render
  // the list on the same item and branch. `fallback` fills the search and
  // branch only when the user hadn't set them (e.g. the item just saved).
  _invFilterState(fallback = {}) {
    const val = id => (document.getElementById(id) || {}).value || '';
    return {
      // Only one of the two tabs' search boxes is on the page at a time.
      search: val('inv-search') || val('noninv-search') || fallback.search || '',
      category: val('inv-cat-filter'),
      brand: val('inv-brand-filter'),
      branchId: val('inv-branch-filter') || (fallback.branchId ? String(fallback.branchId) : ''),
    };
  },

  async renderInventory(activeTab, filters = null) {
    const tab = activeTab || this._inventoryTab || 'all';
    this._inventoryTab = tab;
    const tabBtn = (key, label) => `
      <button class="btn btn-sm ${tab===key?'btn-primary':'btn-outline'}"
        onclick="App.renderInventory('${key}')">${label}</button>`;
    const tabsHtml = `<div style="display:flex;gap:8px;margin-bottom:16px">
      ${tabBtn('all','All Inventory')}
      ${tabBtn('non-inventory','Non-Inventory Items')}
    </div>`;

    if (tab === 'non-inventory') return this.renderNonInventoryTab(tabsHtml, filters);

    const hasFilters = !!(filters && (filters.search || filters.category || filters.brand || filters.branchId));
    const [products, categories, brands, movements, branches] = await Promise.all([
      // Re-rendering onto saved filters: refilter() below fetches the
      // filtered list, so don't pull the whole catalogue first.
      hasFilters ? [] : this.api('GET', '/products?is_service=0&is_rental=0&is_non_inventory=0'),
      this.api('GET', '/categories'),
      this.api('GET', '/brands'),
      this.api('GET', '/products/movements?limit=30'),
      // All branches, not just the ones this employee is individually assigned
      // to (this.currentUser.branches) — this is a browse/oversight filter, not
      // an operational "which branch am I working from" picker like POS's.
      this.api('GET', '/branches'),
    ]);
    if (this.section !== 'inventory') return;

    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Retail Inventory Management</h2>
        <button class="btn btn-primary" onclick="App.showProductForm()">+ Add Product</button>
      </div>
      ${tabsHtml}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <div class="search-bar" style="flex:0 0 auto">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" id="inv-search" placeholder="Search products..." style="width:220px">
        </div>
        <select id="inv-cat-filter" style="width:auto;min-width:140px"><option value="">All Categories</option>${categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
        <select id="inv-brand-filter" style="width:auto;min-width:140px"><option value="">All Brands</option>${brands.map(b => `<option value="${(b.name||'').replace(/"/g,'&quot;')}">${b.name}</option>`).join('')}</select>
        <select id="inv-branch-filter" style="width:auto;min-width:130px">
          <option value="">All Branches</option>
          ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
        </select>
        <div style="flex:1"></div>
        <button class="btn btn-secondary btn-sm" onclick="App.showSection('reports-inventory')" title="Inventory reports — items sold over a period">📊 Reports</button>
        ${this.can('inventory_export') ? `<button class="btn btn-secondary btn-sm" onclick="App.exportInventoryCsv()" title="Export filtered products to CSV">&#8659; Export CSV</button>` : ''}
        ${this.can('inventory_export') ? `<button class="btn btn-secondary btn-sm" onclick="App.showCatalogues()" title="Build and download PDF product catalogues by category or brand">📘 Catalogues</button>` : ''}
        ${this.can('inventory_missing_data') ? `<a class="btn btn-secondary btn-sm" href="/api/products/export/issues" download title="Export active products with $0 price, negative stock, or missing category/supplier/barcode">&#8659; Missing Data</a>` : ''}
        ${this.can('inventory_template') ? `<a class="btn btn-secondary btn-sm" href="/api/products/export/template" download title="Download import template">&#8659; Template</a>` : ''}
        ${this.can('inventory_import') ? `<label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0" title="Import products from CSV or Excel">&#8657; Import<input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="display:none" onchange="App.importProductsCsv(this)"></label>` : ''}
        ${this.can('inventory_import_history') ? `<button class="btn btn-secondary btn-sm" onclick="App.showImportHistory()" title="Review or reverse past CSV imports">Import History</button>` : ''}
        ${this.can('inventory_scan_images') ? `<button class="btn btn-secondary btn-sm" onclick="App.scanProductImages()" title="Assign images already placed in uploads/products/ (named by SKU) to their matching products">Scan Images</button>` : ''}
        <a class="btn btn-secondary btn-sm" href="/api/products/export/stock-mismatches" download title="Items whose overall stock figure doesn't match the total of their branch counts — review before bringing them into line">&#8659; Stock Mismatches</a>
        <button class="btn btn-secondary btn-sm" onclick="App.showBulkAssignBranchModal()" title="Assign every product with no branch stock yet (e.g. after a CSV import) to one branch">Bulk Assign to Branch</button>
        <button class="btn btn-secondary btn-sm" onclick="App.showBulkTaxRateModal()" title="Set the tax rate on every product stocked at one branch">Bulk Tax Rate Change</button>
        ${this.can('inventory_categories') ? `<button class="btn btn-secondary btn-sm" onclick="App.showCategoriesManager()">Categories</button>` : ''}
        ${this.can('inventory_units') ? `<button class="btn btn-secondary btn-sm" onclick="App.showUnitsManager()">Units</button>` : ''}
        ${this.can('inventory_brands') ? `<button class="btn btn-secondary btn-sm" onclick="App.showBrandsManager()">Brands</button>` : ''}
      </div>
      <div class="card">
        <div class="table-wrap" id="inv-table-wrap" style="max-height:65vh;overflow-y:auto">
          ${hasFilters ? '<div class="empty-state"><p>Loading…</p></div>' : this.buildProductTable(products)}
        </div>
      </div>
      <div class="card" style="margin-top:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <h3 style="margin:0;font-size:15px">Recent Stock Activity</h3>
        </div>
        <div id="inv-history-wrap">${this.buildStockHistory(movements)}</div>
      </div>`;

    const refilterHistory = async () => {
      const branchId = document.getElementById('inv-branch-filter').value;
      let url = '/products/movements?limit=30';
      if (branchId) url += `&branch_id=${branchId}`;
      const m = await this.api('GET', url);
      document.getElementById('inv-history-wrap').innerHTML = this.buildStockHistory(m);
    };

    // Only the latest request may paint the table — a slow reply for "h" must
    // not land on top of the one for "hammer".
    let refilterSeq = 0;
    const refilter = async () => {
      const seq = ++refilterSeq;
      const q = document.getElementById('inv-search').value.trim();
      const cat = document.getElementById('inv-cat-filter').value;
      const brand = document.getElementById('inv-brand-filter').value;
      const branchId = document.getElementById('inv-branch-filter').value;
      let url = '/products?is_service=0&is_rental=0&is_non_inventory=0&';
      if (q) url += `search=${encodeURIComponent(q)}&`;
      if (cat) url += `category=${cat}&`;
      if (brand) url += `brand=${encodeURIComponent(brand)}&`;
      if (branchId) url += `branch_id=${branchId}&`;
      const filtered = await this.api('GET', url);
      if (seq !== refilterSeq || this.section !== 'inventory') return;
      const branchName = branchId ? (branches.find(b => b.id == branchId) || {}).name || '' : '';
      document.getElementById('inv-table-wrap').innerHTML = this.buildProductTable(filtered, branchName, branchId);
    };

    // Search once typing pauses rather than on every keystroke; Enter (or a
    // scanner's trailing Enter) searches straight away.
    let searchTimer;
    const searchEl = document.getElementById('inv-search');
    searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refilter, 250); });
    searchEl.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); refilter(); } });
    document.getElementById('inv-cat-filter').addEventListener('change', refilter);
    document.getElementById('inv-brand-filter').addEventListener('change', refilter);
    document.getElementById('inv-branch-filter').addEventListener('change', () => { refilter(); refilterHistory(); });

    if (filters && (filters.search || filters.category || filters.brand || filters.branchId)) {
      document.getElementById('inv-search').value = filters.search || '';
      document.getElementById('inv-cat-filter').value = filters.category || '';
      document.getElementById('inv-brand-filter').value = filters.brand || '';
      document.getElementById('inv-branch-filter').value = filters.branchId || '';
      await refilter();
      if (filters.branchId) await refilterHistory();
    }
  },

  // Products created by linking a received PO item back to a quotation's "Q"
  // item (routes/purchase-orders.js link-product) — purchased for one specific
  // quote, not stocked for general sale. Kept out of the main table above;
  // still fully findable here and via the raw /products search used by the
  // quote/PR pickers, so they can be reused or ordered again later.
  async renderNonInventoryTab(tabsHtml, filters = null) {
    const initialSearch = filters?.search || '';
    const products = await this.api('GET', `/products?is_non_inventory=1${initialSearch ? `&search=${encodeURIComponent(initialSearch)}` : ''}`);
    if (this.section !== 'inventory') return;
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Retail Inventory Management</h2>
      </div>
      ${tabsHtml}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <div class="search-bar" style="flex:0 0 auto">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" id="noninv-search" placeholder="Search non-inventory items..." style="width:240px" value="${this.escapeAttr(initialSearch)}">
        </div>
      </div>
      <p style="color:var(--text-muted);font-size:13px;margin:-8px 0 14px">
        Items purchased to fulfill a specific quotation. They're still searchable when building a new quote or purchase request —
        use "Add to Warehouse Inventory" once you're stocking one for general sale.
      </p>
      <div class="card">
        <div class="table-wrap" id="noninv-table-wrap" style="max-height:65vh;overflow-y:auto">
          ${this.buildNonInventoryTable(products)}
        </div>
      </div>`;

    // Same as the All Inventory tab: search once typing pauses (Enter at
    // once), and only the latest request may paint the table.
    let refilterSeq = 0, searchTimer;
    const searchEl = document.getElementById('noninv-search');
    const refilter = async () => {
      const seq = ++refilterSeq;
      const q = searchEl.value.trim();
      const filtered = await this.api('GET', `/products?is_non_inventory=1${q ? `&search=${encodeURIComponent(q)}` : ''}`);
      if (seq !== refilterSeq || !document.getElementById('noninv-table-wrap')) return;
      document.getElementById('noninv-table-wrap').innerHTML = this.buildNonInventoryTable(filtered);
    };
    searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refilter, 250); });
    searchEl.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); refilter(); } });
  },

  buildNonInventoryTable(products) {
    if (!products.length) return '<div class="empty-state"><p>No non-inventory items found</p></div>';
    return `<table class="sticky-table">
      <thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Price</th><th>Cost</th><th>Stock</th><th>Actions</th></tr></thead>
      <tbody>
        ${products.map(p => `<tr id="noninv-row-${p.id}">
          <td style="font-family:monospace;font-size:12px">${p.sku}</td>
          <td class="fw-600">${p.name}</td>
          <td style="color:var(--text-muted)">${p.category_name || '—'}</td>
          <td>${this.fmt(p.price)}</td>
          <td style="color:var(--text-muted)">${this.fmt(p.cost)}</td>
          <td>${p.stock_qty}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-outline btn-sm" onclick="App.showProductCard(${p.id})">View</button>
            <button class="btn btn-secondary btn-sm" onclick="App.showProductForm(${p.id})">Edit</button>
            <button class="btn btn-primary btn-sm" onclick="App.promoteToInventory(${p.id})">Add to Warehouse Inventory</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  },

  async promoteToInventory(id) {
    try {
      await this.api('PATCH', `/products/${id}/promote-to-inventory`);
      this.alert('Added to warehouse inventory — it now shows under All Inventory');
      this.renderInventory('non-inventory', this._invFilterState());
    } catch(e) { this.alert(e.message, 'error'); }
  },

  buildStockHistory(movements) {
    const { adjustments = [], transfers = [] } = movements;
    const fmtDate = d => d ? this._toDate(d).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZone: this._storeTz() }) : '—';
    const rows = [];
    for (const a of adjustments) {
      rows.push({ date: a.created_at, product: a.product_name, sku: a.sku, branch: a.branch_name || '—', change: a.quantity_change, type: 'Adjustment', detail: a.reason || '—' });
    }
    for (const t of transfers) {
      rows.push({ date: t.created_at, product: t.product_name, sku: t.sku, branch: `${t.from_branch_name} → ${t.to_branch_name}`, change: null, type: `Transfer (${t.status})`, detail: `${t.transfer_number} · ${t.quantity_received}/${t.quantity_requested} received`, received_at: t.received_at });
    }
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (!rows.length) return '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No stock activity yet.</p>';
    return `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Product</th><th>SKU</th><th>Branch / Route</th><th>Change</th><th>Type</th><th>Detail</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td style="white-space:nowrap;font-size:12px">${fmtDate(r.date)}</td>
        <td class="fw-600">${r.product}</td>
        <td style="font-family:monospace;font-size:12px">${r.sku}</td>
        <td style="font-size:12px">${r.branch}</td>
        <td style="font-weight:600;color:${r.change === null ? 'var(--text-muted)' : r.change > 0 ? 'var(--success)' : 'var(--danger)'}">${r.change === null ? '—' : (r.change > 0 ? '+' : '') + r.change}</td>
        <td><span class="badge-pill ${r.type.startsWith('Transfer') ? 'badge-info' : 'badge-warning'}" style="font-size:11px">${r.type}</span></td>
        <td style="font-size:12px;color:var(--text-muted)">${r.detail}${r.received_at ? ' · rcvd ' + fmtDate(r.received_at) : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  },

  // ─── Product catalogues (PDF) ─────────────────────────────────────────────
  // Saved selections of products by category and/or brand, rendered to PDF
  // by routes/catalogues.js — see lib/catalogue.js for the layout.
  async showCatalogues() {
    const list = await this.api('GET', '/catalogues');
    const esc = v => this.escapeAttr(v);
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">Product Catalogues</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Pick products by category or brand, name and describe the catalogue, and download it as a PDF. Saved catalogues always download with current prices and images.</p>
          ${list.length ? `<table>
            <thead><tr><th>Name</th><th>Selection</th><th>Updated</th><th></th></tr></thead>
            <tbody>${list.map(c => `<tr>
              <td><div class="fw-600">${esc(c.name)}</div>${c.description ? `<div style="font-size:11px;color:var(--text-muted)">${esc(c.description)}</div>` : ''}</td>
              <td style="font-size:12px">${[c.category_ids.length ? `${c.category_ids.length} categor${c.category_ids.length === 1 ? 'y' : 'ies'}` : '', c.brands.length ? `${c.brands.length} brand${c.brands.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}${c.excluded_product_ids.length ? `<br><span style="color:var(--text-muted)">${c.excluded_product_ids.length} product${c.excluded_product_ids.length === 1 ? '' : 's'} left out</span>` : ''}</td>
              <td style="font-size:12px;white-space:nowrap">${this.fmtDateTime(c.updated_at)}${c.created_by_name ? `<br><span style="color:var(--text-muted)">${esc(c.created_by_name)}</span>` : ''}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-sm btn-primary" onclick="App.downloadCatalogue(${c.id}, this)">⬇ PDF</button>
                <button class="btn btn-sm btn-secondary" onclick="App.showCatalogueForm(${c.id})">Edit</button>
                <button class="btn btn-sm btn-danger" onclick="App.deleteCatalogue(${c.id})">Del</button>
              </td></tr>`).join('')}</tbody>
          </table>` : '<div class="empty-state"><p>No catalogues yet</p></div>'}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-primary" onclick="App.showCatalogueForm()">+ New Catalogue</button>
        </div>
      </div>`);
  },

  async showCatalogueForm(id) {
    const [c, categories, brands] = await Promise.all([
      id ? this.api('GET', `/catalogues/${id}`) : Promise.resolve({ name: '', description: '', category_ids: [], brands: [], excluded_product_ids: [], show_prices: 1 }),
      this.api('GET', '/categories'),
      this.api('GET', '/brands'),
    ]);
    this._catalogueEditId = id || null;
    this._catalogueExcluded = new Set(c.excluded_product_ids.map(Number));
    const esc = v => this.escapeAttr(v);
    const selCats = new Set(c.category_ids.map(Number));
    const selBrands = new Set(c.brands.map(b => b.toLowerCase()));
    const box = 'display:flex;flex-wrap:wrap;gap:6px 14px;max-height:150px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:10px';
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit' : 'New'} Catalogue</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Catalogue Name *</label><input id="cat-name" value="${esc(c.name)}" placeholder="e.g. Power Tools 2026"></div>
          <div class="form-group"><label>Description</label><textarea id="cat-desc" rows="2" placeholder="Shown on the cover page">${esc(c.description || '')}</textarea></div>
          <div class="form-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal"><input type="checkbox" id="cat-prices" ${c.show_prices ? 'checked' : ''} style="width:auto;margin:0"> Show prices</label></div>
          <div class="input-row">
            <div class="form-group"><label>Categories</label>
              <div style="${box}">${categories.length ? categories.map(cat => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:normal;cursor:pointer;text-transform:none;letter-spacing:0;color:var(--text)"><input type="checkbox" class="cat-cat-cb" value="${cat.id}" ${selCats.has(Number(cat.id)) ? 'checked' : ''} onchange="App._refreshCataloguePreview()" style="width:auto;margin:0"> ${esc(cat.name)}</label>`).join('') : '<span style="font-size:12px;color:var(--text-muted)">No categories</span>'}</div>
            </div>
            <div class="form-group"><label>Brands</label>
              <div style="${box}">${brands.length ? brands.map(b => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:normal;cursor:pointer;text-transform:none;letter-spacing:0;color:var(--text)"><input type="checkbox" class="cat-brand-cb" value="${esc(b.name)}" ${selBrands.has(String(b.name).toLowerCase()) ? 'checked' : ''} onchange="App._refreshCataloguePreview()" style="width:auto;margin:0"> ${esc(b.name)} <span style="color:var(--text-muted);font-size:11px">(${b.product_count})</span></label>`).join('') : '<span style="font-size:12px;color:var(--text-muted)">No brands</span>'}</div>
            </div>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:-6px 0 10px">Pick categories, brands, or both — with both, a product must match one of each (e.g. Drills by DeWalt). Services and rental-only items aren't included.</p>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <strong style="font-size:13px">Products</strong>
            <span id="cat-count" style="font-size:12px;color:var(--text-muted)"></span>
            <div style="flex:1"></div>
            <input id="cat-filter" placeholder="Filter…" style="width:160px" oninput="App._filterCataloguePreview()">
            <button class="btn btn-sm btn-outline" onclick="App._setAllCatalogueProducts(true)">All</button>
            <button class="btn btn-sm btn-outline" onclick="App._setAllCatalogueProducts(false)">None</button>
          </div>
          <div id="cat-products" style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.showCatalogues()">Back</button>
          <button class="btn btn-outline" onclick="App.saveCatalogue(true)">Save &amp; Download PDF</button>
          <button class="btn btn-primary" onclick="App.saveCatalogue(false)">Save</button>
        </div>
      </div>`);
    this._refreshCataloguePreview();
  },

  _catalogueSelection() {
    return {
      category_ids: [...document.querySelectorAll('.cat-cat-cb:checked')].map(cb => Number(cb.value)),
      brands: [...document.querySelectorAll('.cat-brand-cb:checked')].map(cb => cb.value),
    };
  },

  async _refreshCataloguePreview() {
    const el = document.getElementById('cat-products');
    if (!el) return;
    const sel = this._catalogueSelection();
    if (!sel.category_ids.length && !sel.brands.length) {
      this._catalogueProducts = [];
      el.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--text-muted)">Pick at least one category or brand.</div>';
      this._updateCatalogueCount();
      return;
    }
    const seq = (this._cataloguePreviewSeq = (this._cataloguePreviewSeq || 0) + 1);
    el.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--text-muted)">Loading…</div>';
    const products = await this.api('POST', '/catalogues/preview', sel);
    if (seq !== this._cataloguePreviewSeq) return; // a newer selection is already loading
    this._catalogueProducts = products;
    const esc = v => this.escapeAttr(v);
    el.innerHTML = products.length ? products.map(p => `
      <label class="cat-prod-row" data-search="${esc(`${p.name} ${p.sku || ''} ${p.category_name || ''} ${p.brand || ''}`.toLowerCase())}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);font-weight:normal;cursor:pointer;margin:0;text-transform:none;letter-spacing:0;color:var(--text)">
        <input type="checkbox" class="cat-prod-cb" value="${p.id}" ${this._catalogueExcluded.has(Number(p.id)) ? '' : 'checked'} onchange="App._toggleCatalogueProduct(${p.id}, this.checked)" style="width:auto;margin:0">
        <span style="flex:1;font-size:13px"><span class="fw-600">${esc(p.name)}</span> <span style="color:var(--text-muted);font-size:11px">${esc(p.sku || '')} · ${esc(p.category_name || 'No category')}${p.brand ? ' · ' + esc(p.brand) : ''}${p.image_path ? '' : ' · no image'}</span></span>
        <span style="font-size:12px;margin-left:auto;white-space:nowrap">${this.fmt(p.price)}</span>
      </label>`).join('') : '<div style="padding:14px;font-size:12px;color:var(--text-muted)">No active products match this selection.</div>';
    this._filterCataloguePreview();
    this._updateCatalogueCount();
  },

  _toggleCatalogueProduct(id, on) {
    if (on) this._catalogueExcluded.delete(Number(id)); else this._catalogueExcluded.add(Number(id));
    this._updateCatalogueCount();
  },

  // All/None act on the rows currently shown by the filter box.
  _setAllCatalogueProducts(on) {
    document.querySelectorAll('.cat-prod-row').forEach(row => {
      if (row.style.display === 'none') return;
      const cb = row.querySelector('.cat-prod-cb');
      cb.checked = on;
      this._toggleCatalogueProduct(cb.value, on);
    });
  },

  _filterCataloguePreview() {
    const q = (document.getElementById('cat-filter')?.value || '').trim().toLowerCase();
    document.querySelectorAll('.cat-prod-row').forEach(row => { row.style.display = !q || row.dataset.search.includes(q) ? 'flex' : 'none'; });
  },

  _updateCatalogueCount() {
    const el = document.getElementById('cat-count');
    if (!el) return;
    const all = this._catalogueProducts || [];
    const included = all.filter(p => !this._catalogueExcluded.has(Number(p.id))).length;
    el.textContent = all.length ? `${included} of ${all.length} included` : '';
  },

  async saveCatalogue(download) {
    const sel = this._catalogueSelection();
    // Only remember exclusions for products still in the selection.
    const inSelection = new Set((this._catalogueProducts || []).map(p => Number(p.id)));
    const data = {
      name: document.getElementById('cat-name').value.trim(),
      description: document.getElementById('cat-desc').value.trim(),
      show_prices: document.getElementById('cat-prices').checked,
      ...sel,
      excluded_product_ids: [...this._catalogueExcluded].filter(id => inSelection.has(id)),
    };
    if (!data.name) return this.alert('Catalogue name is required', 'error');
    if (!sel.category_ids.length && !sel.brands.length) return this.alert('Pick at least one category or brand', 'error');
    if (inSelection.size && data.excluded_product_ids.length === inSelection.size) return this.alert('Every product is unticked — tick at least one', 'error');
    try {
      let id = this._catalogueEditId;
      if (id) await this.api('PUT', `/catalogues/${id}`, data);
      else id = (await this.api('POST', '/catalogues', data)).id;
      this.alert('Catalogue saved');
      await this.showCatalogues();
      if (download) this.downloadCatalogue(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Fetched as a blob (rather than a plain link) so a server-side error shows
  // as an alert instead of downloading a broken file.
  async downloadCatalogue(id, btn) {
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
    else this.alert('Generating catalogue PDF…', 'info');
    try {
      const res = await fetch(`/api/catalogues/${id}/pdf`);
      if (!res.ok) {
        let msg = 'Could not generate the catalogue';
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'catalogue.pdf';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch(e) { this.alert(e.message, 'error'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
  },

  async deleteCatalogue(id) {
    if (!confirm('Delete this catalogue? (Only the saved selection is deleted — no products are affected.)')) return;
    try {
      await this.api('DELETE', `/catalogues/${id}`);
      this.alert('Catalogue deleted');
      this.showCatalogues();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  exportInventoryCsv() {
    const q = (document.getElementById('inv-search') || {}).value || '';
    const cat = (document.getElementById('inv-cat-filter') || {}).value || '';
    const branchId = (document.getElementById('inv-branch-filter') || {}).value || '';
    let url = '/api/products/export?is_service=0&is_rental=0&is_non_inventory=0&';
    if (q) url += `search=${encodeURIComponent(q)}&`;
    if (cat) url += `category=${encodeURIComponent(cat)}&`;
    if (branchId) url += `branch_id=${encodeURIComponent(branchId)}&`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  // The full catalogue is thousands of rows, each with half a dozen buttons —
  // building them all at once is what made the table slow. Only the first
  // INV_ROW_BATCH are drawn; the rest are appended as #inv-table-wrap is
  // scrolled toward the bottom (_invMoreRows).
  INV_ROW_BATCH: 200,

  buildProductTable(products, branchName = '', branchId = '') {
    this._invTable = { products, branchName, branchId, shown: 0 };
    setTimeout(() => this._invBindScroll());
    if (!products.length) return '<div class="empty-state"><p>No products found</p></div>';
    const stockHeader = branchName ? `Stock (${branchName})` : 'Stock';
    const first = this._invTakeRows();
    return `<table class="sticky-table">
      <thead><tr><th></th><th>SKU</th><th>Name</th><th>Category</th><th>Price</th><th>Cost</th><th>${stockHeader}</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody id="inv-tbody">${first}</tbody>
    </table>
    <div id="inv-more" style="padding:10px;text-align:center;color:var(--text-muted);font-size:12px;${this._invTable.shown < products.length ? '' : 'display:none'}">
      Showing <span id="inv-shown">${this._invTable.shown}</span> of ${products.length} — scroll for more
    </div>`;
  },

  _invTakeRows() {
    const t = this._invTable;
    const slice = t.products.slice(t.shown, t.shown + this.INV_ROW_BATCH);
    t.shown += slice.length;
    return this._invRowsHtml(slice, t.branchName, t.branchId);
  },

  _invBindScroll() {
    const wrap = document.getElementById('inv-table-wrap');
    if (wrap) wrap.onscroll = () => {
      if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 400) this._invMoreRows();
    };
  },

  _invMoreRows() {
    const t = this._invTable, tbody = document.getElementById('inv-tbody');
    if (!t || !tbody || t.shown >= t.products.length) return;
    tbody.insertAdjacentHTML('beforeend', this._invTakeRows());
    const shownEl = document.getElementById('inv-shown');
    if (shownEl) shownEl.textContent = t.shown;
    if (t.shown >= t.products.length) document.getElementById('inv-more').style.display = 'none';
  },

  _invRowsHtml(products, branchName, branchId) {
    return `
        ${products.map(p => `<tr id="inv-row-${p.id}">
          <td style="width:52px">${p.image_path ? `<img src="${p.image_path}" class="prod-img-thumb" alt="" loading="lazy" decoding="async">` : `<div class="prod-img-placeholder" onclick="App.showProductForm(${p.id})">📷</div>`}</td>
          <td style="font-family:monospace;font-size:12px">${p.sku}</td>
          <td class="fw-600">${p.name}${p.has_variations > 0 ? `<span class="has-vars-badge">${p.has_variations} var</span>` : ''}${p.used_of_product_id ? `<span class="badge-pill badge-purple" style="font-size:10px;margin-left:6px">Used</span>` : ''}${p.merged_into_product_id ? `<span class="badge-pill badge-secondary" style="font-size:10px;margin-left:6px" title="Merged into ${p.merged_into_sku||''}">Merged → ${p.merged_into_sku||'?'}</span>` : ''}</td>
          <td style="color:var(--text-muted)">${p.category_name || '—'}</td>
          <td>${this.fmt(p.price)}</td>
          <td style="color:var(--text-muted)">${this.fmt(p.cost)}</td>
          <td>
            <span class="${p.stock_qty <= p.min_stock ? 'color-danger fw-600' : ''}">${p.stock_qty}</span>
            <span style="color:var(--text-muted);font-size:11px"> / min ${p.min_stock}</span>
          </td>
          <td><span class="badge-pill ${p.active ? 'badge-success' : 'badge-danger'}">${p.active ? 'Active' : 'Inactive'}</span></td>
          <td style="white-space:nowrap">
            <button class="btn btn-outline btn-sm" onclick="App.showProductCard(${p.id})">View</button>
            <button class="btn btn-secondary btn-sm" onclick="App.showProductForm(${p.id}${branchId ? `,${branchId}` : ''})">Edit</button>
            ${this.can('inventory_adjust') ? `<button class="btn btn-outline btn-sm" onclick="App.showStockAdjust(${p.id},${this.escapeAttr(JSON.stringify(p.name))},${Number(p.stock_qty) || 0}${branchId ? `,${branchId},${this.escapeAttr(JSON.stringify(branchName))}` : ''})">Stock</button>` : ''}
            <button class="btn btn-secondary btn-sm" id="inv-hist-btn-${p.id}" onclick="App.toggleProductHistory(${p.id})" title="Stock history" style="padding:4px 7px">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7v2l4-4-4-4v2zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8z"/></svg>
            </button>
            ${this.can('inventory_print_labels') ? `<button class="btn btn-secondary btn-sm" onclick="App.showLabelPrint(${p.id})" title="Print Labels" style="padding:4px 7px">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>
            </button>` : ''}
            ${!p.merged_into_product_id && !p.is_rental && !(p.has_variations > 0) && this.can('inventory_merge') ? `<button class="btn btn-outline btn-sm" onclick="App.showMergeProductModal(${p.id})" title="Merge this duplicate into another product">Merge</button>` : ''}
          </td>
        </tr>
        <tr id="inv-hist-${p.id}" style="display:none">
          <td colspan="9" style="padding:0;background:var(--bg-secondary)"></td>
        </tr>`).join('')}`;
  },

  // Merges a duplicate retail SKU (id) into another product the user picks —
  // combines stock and history onto the survivor, retires the duplicate
  // (deactivated, tagged, never deleted). Rental items and anything with
  // active variations are excluded server-side; this list mirrors that so
  // the picker never offers an ineligible target.
  async showMergeProductModal(id) {
    const [source, all] = await Promise.all([
      this.api('GET', `/products/${id}`),
      this.api('GET', '/products?active=1'),
    ]);
    this._mergeSource = source;
    this._mergeCandidates = all.filter(p => p.id !== source.id && !p.is_rental && !p.merged_into_product_id && !(p.has_variations > 0));
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">Merge Duplicate SKU</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)"><strong>${this.escapeAttr(source.name)}</strong> (${source.sku}) will be deactivated and its stock (${source.stock_qty}) and history moved onto whichever product you pick below. This can't be undone from here.</p>
          <div class="form-group">
            <label>Merge into *</label>
            <input type="text" id="merge-search" placeholder="Search by name or SKU..." oninput="App._filterMergeTargets()">
            <select id="merge-target" size="8" style="width:100%;margin-top:6px" onchange="App._updateMergePreview()">
              ${this._mergeTargetOptionsHtml(this._mergeCandidates)}
            </select>
          </div>
          <div id="merge-preview" style="font-size:13px;background:var(--bg-secondary,#f8f9fa);border:1px solid var(--border);border-radius:6px;padding:8px 10px;display:none"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" id="merge-confirm-btn" onclick="App.confirmMergeProduct()" disabled>Merge</button>
        </div>
      </div>`);
  },

  _mergeTargetOptionsHtml(list) {
    if (!list.length) return '<option value="">No eligible products</option>';
    return list.map(p => `<option value="${p.id}">${p.sku} — ${p.name} (Stock: ${p.stock_qty})</option>`).join('');
  },

  _filterMergeTargets() {
    const q = document.getElementById('merge-search').value.trim().toLowerCase();
    const filtered = !q ? this._mergeCandidates : this._mergeCandidates.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    document.getElementById('merge-target').innerHTML = this._mergeTargetOptionsHtml(filtered);
    this._updateMergePreview();
  },

  _updateMergePreview() {
    const sel = document.getElementById('merge-target');
    const preview = document.getElementById('merge-preview');
    const btn = document.getElementById('merge-confirm-btn');
    const targetId = parseInt(sel.value);
    if (!targetId) { preview.style.display = 'none'; btn.disabled = true; return; }
    const target = this._mergeCandidates.find(p => p.id === targetId);
    const source = this._mergeSource;
    preview.style.display = 'block';
    preview.innerHTML = `After merging: <strong>${this.escapeAttr(target.name)}</strong> (${target.sku}) stock becomes <strong>${(target.stock_qty||0) + (source.stock_qty||0)}</strong> (${target.stock_qty||0} + ${source.stock_qty||0}). <strong>${this.escapeAttr(source.name)}</strong> (${source.sku}) will be deactivated and marked as merged.`;
    btn.disabled = false;
  },

  async confirmMergeProduct() {
    const targetId = parseInt(document.getElementById('merge-target').value);
    if (!targetId) return;
    const source = this._mergeSource;
    const target = this._mergeCandidates.find(p => p.id === targetId);
    if (!confirm(`Merge "${source.name}" (${source.sku}) into "${target.name}" (${target.sku})? This can't be undone from here.`)) return;
    try {
      await this.api('POST', `/products/${source.id}/merge`, { target_id: targetId });
      this.closeModal();
      this.alert(`Merged ${source.sku} into ${target.sku}`);
      this.renderInventory(this._inventoryTab);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async toggleProductHistory(id) {
    const row = document.getElementById(`inv-hist-${id}`);
    const btn = document.getElementById(`inv-hist-btn-${id}`);
    if (!row) return;
    if (row.style.display !== 'none') {
      row.style.display = 'none';
      if (btn) btn.style.opacity = '';
      return;
    }
    row.style.display = '';
    const cell = row.cells[0];
    cell.innerHTML = '<div style="padding:12px 16px;color:var(--text-muted);font-size:13px">Loading history…</div>';
    if (btn) btn.style.opacity = '0.5';
    try {
      const movements = await this.api('GET', `/products/${id}/movements`);
      if (btn) btn.style.opacity = '';
      if (!movements.length) {
        cell.innerHTML = '<div style="padding:12px 16px;color:var(--text-muted);font-size:13px">No stock history found.</div>';
        return;
      }
      const fmtDate = d => d ? this._toDate(d).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZone: this._storeTz() }) : '—';
      const typeLabel = { sale: 'Sale', transfer_out: 'Transfer Out', transfer_in: 'Transfer In', adjustment: 'Adjustment', received: 'Received', receipt_reversed: 'Receipt Reversed' };
      const typeColor = { sale: 'var(--danger)', transfer_out: 'var(--warning,#f59e0b)', transfer_in: 'var(--success)', adjustment: 'var(--primary)', received: 'var(--success)', receipt_reversed: 'var(--danger)' };
      cell.innerHTML = `<div style="padding:8px 16px">
        <table style="width:100%;font-size:12px;border:none">
          <thead><tr style="border-bottom:1px solid var(--border)">
            <th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--text-muted)">Date</th>
            <th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--text-muted)">Type</th>
            <th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--text-muted)">Branch</th>
            <th style="padding:4px 8px;text-align:right;font-weight:600;color:var(--text-muted)">Change</th>
            <th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--text-muted)">Reference</th>
            <th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--text-muted)">Detail</th>
          </tr></thead>
          <tbody>${movements.map(m => `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:5px 8px;white-space:nowrap">${fmtDate(m.date)}</td>
            <td style="padding:5px 8px;font-weight:600;color:${typeColor[m.type]||'inherit'}">${typeLabel[m.type]||m.type}</td>
            <td style="padding:5px 8px">${m.branch_name||'—'}</td>
            <td style="padding:5px 8px;text-align:right;font-weight:700;color:${m.qty>0?'var(--success)':'var(--danger)'}">${m.qty>0?'+':''}${m.qty}</td>
            <td style="padding:5px 8px;font-family:monospace">${m.reference||'—'}</td>
            <td style="padding:5px 8px;color:var(--text-muted)">${m.detail||'—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
    } catch(e) {
      if (btn) btn.style.opacity = '';
      cell.innerHTML = '<div style="padding:12px 16px;color:var(--danger);font-size:13px">Failed to load history.</div>';
    }
  },

  // Read-only product card (View button on the Inventory and Rental Items
  // lists) — photo, pricing/rates, stock, and both descriptions, including
  // the detailed website copy, without opening the edit form.
  async showProductCard(id) {
    let p, accessories = [];
    try {
      p = await this.api('GET', `/products/${id}`);
      if (p.is_rental) accessories = await this.api('GET', `/products/${id}/accessories`).catch(() => []);
      // Same as showRentalItemForm: once assigned to a branch, branch_inventory
      // is the real stock figure, not the (possibly stale) global column.
      if (p.is_rental && p.assigned_branch_id && !p.is_accessory) {
        const scoped = await this.api('GET', `/products/${id}?branch_id=${p.assigned_branch_id}`);
        p.stock_qty = scoped.branch_stock_qty;
      }
    } catch(e) { this.alert(e.message, 'error'); return; }
    const esc = v => this.escapeAttr(v);
    const isRental = !!p.is_rental;
    const isEquipment = p.rental_classification === 'equipment';
    const row = (label, value) => value === null || value === undefined || value === '' ? '' :
      `<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px"><span style="color:var(--text-muted)">${label}</span><span style="text-align:right;font-weight:600">${value}</span></div>`;
    const rates = !isRental ? row('Price', this.fmt(p.price)) : isEquipment
      ? [['Hourly', p.rental_hourly_rate], ['Daily', p.rental_rate], ['Weekly', p.rental_weekly_rate], ['Monthly', p.rental_monthly_rate]].filter(([, v]) => v > 0).map(([l, v]) => row(`${l} Rate`, this.fmt(v))).join('')
      : (() => { const t = this._toolTierDayRates(p.rental_rate); return row('Daily Rate', this.fmt(p.rental_rate)) + row('Weekly Tier', `${this.fmt(t.weekTierDayRate)}/day`) + row('Monthly Tier', `${this.fmt(t.monthTierDayRate)}/day`); })();
    // Same keys PUT /products/:id checks (requiredProductPermission), so the
    // card opened from POS Item Zoom only offers Edit to people who can save.
    const canEdit = isRental ? this.can('rentals_manage_items') : p.is_service ? this.can('services') : this.can('inventory_edit');
    const editCall = isRental ? `App.showRentalItemForm(${p.id})` : `App.showProductForm(${p.id})`;
    this.showModal(`
      <div class="modal" style="max-width:720px">
        <div class="modal-header">
          <span class="modal-title">${esc(p.name)}</span>
          <div style="display:flex;gap:6px;align-items:center">
            ${isRental ? `<span class="badge-pill ${isEquipment?'badge-info':'badge-secondary'}" style="font-size:10px">${isEquipment?'RENTAL · EQUIPMENT':'RENTAL · TOOL'}</span>` : ''}
            ${p.online_available ? '<span class="badge-pill badge-info" style="font-size:10px">ONLINE</span>' : ''}
            <span class="badge-pill ${p.active ? 'badge-success' : 'badge-danger'}" style="font-size:10px">${p.active ? 'Active' : 'Inactive'}</span>
            <button class="modal-close">✕</button>
          </div>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:20px;flex-wrap:wrap">
            <div style="flex:0 0 220px;max-width:100%">
              ${p.image_path
                ? `<img src="${esc(p.image_path)}" alt="" style="width:100%;max-height:240px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff">`
                : '<div style="width:100%;height:180px;border:1px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px">No photo</div>'}
            </div>
            <div style="flex:1;min-width:240px">
              ${row('SKU', `<span style="font-family:monospace">${esc(p.sku)}</span>`)}
              ${row('Barcode', p.barcode ? esc(p.barcode) : '')}
              ${row('Category', p.category_name ? esc(p.category_name) : '')}
              ${row('Brand', p.brand ? esc(p.brand) : '')}
              ${row('Model', p.model_number ? esc(p.model_number) : '')}
              ${row('Size', p.size ? esc(p.size) : '')}
              ${rates}
              ${isRental && p.rental_allow_sale ? row('Sale Price', this.fmt(p.price)) : ''}
              ${isRental && p.rental_deposit > 0 ? row('Deposit', this.fmt(p.rental_deposit)) : ''}
              ${isRental && p.replacement_value > 0 ? row('Replacement Value', this.fmt(p.replacement_value)) : ''}
              ${p.is_service ? '' : row('Stock', `${p.stock_qty}${p.base_unit_id ? ' ' + esc(p.base_unit_abbr || p.base_unit_name) : p.unit ? ' ' + esc(p.unit) : ''}`)}
              ${(p.units || []).length ? row('Also sold in', p.units.map(u => `${esc(u.label)} (= ${u.factor} ${esc(p.base_unit_abbr || p.base_unit_name || 'ea')})${u.price != null ? ' · ' + this.fmt(u.price) : ''}`).join('<br>')) : ''}
              ${p.branch_stock?.length ? row('By Location', p.branch_stock.map(s => `${esc(s.branch_name)}: ${s.stock_qty}`).join('<br>')) : ''}
              ${row('Tax', p.taxable === 0 ? 'Not taxable' : `${p.tax_rate}%`)}
            </div>
          </div>
          ${p.description ? `<p style="margin:16px 0 0;font-size:14px">${esc(p.description)}</p>` : ''}
          <div style="margin-top:16px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Detailed Description${p.online_available ? ' · shown on website' : ''}</div>
            ${p.long_description
              ? `<div style="font-size:13px;line-height:1.6;white-space:pre-wrap;border:1px solid var(--border);border-radius:6px;padding:10px 12px;max-height:280px;overflow-y:auto">${esc(p.long_description)}</div>`
              : '<div style="font-size:13px;color:var(--text-muted)">No detailed description yet.</div>'}
          </div>
          ${accessories.length ? `<div style="margin-top:16px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Accessories</div>
            ${accessories.map(a => `<div style="font-size:13px;padding:3px 0">${esc(a.name)} <span style="color:var(--text-muted);font-family:monospace;font-size:11px">${esc(a.sku)}</span> <span class="badge-pill ${a.is_mandatory?'badge-success':'badge-secondary'}" style="font-size:10px">${a.is_mandatory?'included':'optional'}</span></div>`).join('')}
          </div>` : ''}
        </div>
        <div class="modal-footer">
          ${canEdit ? `<button class="btn btn-secondary" onclick="App.closeModal();${editCall}">Edit</button>` : ''}
          <button class="btn btn-primary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  // Units of measure box on the product form (lib/units.js): the stock unit
  // plus any alternate units it's also sold/ordered in, each with how many
  // stock units it holds, its price and its own barcode.
  _pfUnitsSectionHtml(p) {
    const uoms = (this._uoms || []).filter(u => u.active || u.id === p.base_unit_id || (p.units || []).some(x => x.unit_id === u.id));
    const baseOpts = `<option value="">Each</option>` + uoms.filter(u => u.name.toLowerCase() !== 'each').map(u => `<option value="${u.id}" ${u.id === p.base_unit_id ? 'selected' : ''}>${this.escapeAttr(u.name)}</option>`).join('');
    return `<div class="form-group" id="pf-units-box" style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <label style="margin:0;font-weight:600">Units of Measure</label>
        ${this.can('inventory_units') || this.can('settings') ? `<button type="button" class="btn btn-secondary btn-sm" onclick="App.showUnitsManager(true)">Manage Units</button>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">
        <span style="font-size:13px">Stock counted in</span>
        <select id="pf-base-unit" style="width:auto;min-width:130px" onchange="App._pfRefreshUnitLabels()">${baseOpts}</select>
        <span style="font-size:11px;color:var(--text-muted)">Price, cost and stock above are per this unit.</span>
      </div>
      <div id="pf-unit-rows" style="margin-top:8px">${(p.units || []).map(u => this._pfUnitRowHtml(u)).join('')}</div>
      <button type="button" class="btn btn-secondary btn-sm" style="margin-top:6px" onclick="App._pfAddUnitRow()">+ Add alternate unit</button>
      <p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">An alternate unit (e.g. Yard, Case of 24) is offered when the item is added to a sale, quote, layaway or purchase order. Stock always moves in the stock unit — selling 2 yards of an item stocked in feet takes 6 feet off stock. Leave an alternate unit's price blank to only order it from suppliers in that unit.</p>
    </div>`;
  },

  _pfUnitRowHtml(u = {}) {
    const uoms = (this._uoms || []).filter(x => x.active || x.id === u.unit_id);
    return `<div class="pf-unit-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
      <select class="pf-unit-id" style="width:auto;min-width:120px"><option value="">Unit…</option>${uoms.map(x => `<option value="${x.id}" ${x.id === u.unit_id ? 'selected' : ''}>${this.escapeAttr(x.name)}</option>`).join('')}</select>
      <span style="font-size:12px">=</span>
      <input class="pf-unit-factor" type="number" min="0" step="any" value="${u.factor ?? ''}" placeholder="How many" style="width:90px" title="How many stock units are in one of this unit">
      <span class="pf-unit-base-label" style="font-size:12px;color:var(--text-muted);min-width:40px"></span>
      <input class="pf-unit-price" type="number" min="0" step="0.01" value="${u.price ?? ''}" placeholder="Price" style="width:100px" title="Selling price for one of this unit">
      <input class="pf-unit-barcode" value="${this.escapeAttr(u.barcode || '')}" placeholder="Barcode (optional)" style="width:150px">
      <button type="button" class="btn btn-sm btn-danger" onclick="this.closest('.pf-unit-row').remove()">✕</button>
    </div>`;
  },

  _pfAddUnitRow() {
    document.getElementById('pf-unit-rows')?.insertAdjacentHTML('beforeend', this._pfUnitRowHtml());
    this._pfRefreshUnitLabels();
  },

  _pfRefreshUnitLabels() {
    const sel = document.getElementById('pf-base-unit');
    const name = sel?.selectedOptions[0]?.textContent || 'Each';
    document.querySelectorAll('#pf-unit-rows .pf-unit-base-label').forEach(el => { el.textContent = name.toLowerCase() === 'each' ? 'each' : name; });
  },

  // { base_unit_id, units: [...] }, an error message, or null when the form
  // has no units box (rental/service forms).
  _pfReadUnits() {
    const baseSel = document.getElementById('pf-base-unit');
    if (!baseSel) return null;
    const base_unit_id = baseSel.value ? Number(baseSel.value) : null;
    const units = [];
    for (const row of document.querySelectorAll('#pf-unit-rows .pf-unit-row')) {
      const unit_id = Number(row.querySelector('.pf-unit-id').value) || null;
      const factorRaw = row.querySelector('.pf-unit-factor').value;
      const priceRaw = row.querySelector('.pf-unit-price').value;
      const barcode = row.querySelector('.pf-unit-barcode').value.trim();
      if (!unit_id && !factorRaw && !priceRaw && !barcode) continue; // blank row
      const name = row.querySelector('.pf-unit-id').selectedOptions[0]?.textContent;
      if (!unit_id) return 'Choose the unit on every alternate unit row';
      if (!(Number(factorRaw) > 0)) return `Enter how many stock units are in one ${name}`;
      units.push({ unit_id, factor: Number(factorRaw), price: priceRaw === '' ? null : Number(priceRaw), barcode: barcode || null });
    }
    return { base_unit_id, units };
  },

  // branchId (the inventory list's branch filter) picks which branch's stock
  // the Stock Qty box edits — see _pfStockFieldHtml.
  async showProductForm(id, branchId = '') {
    const [categories, brands, branches, suppliers, uoms] = await Promise.all([
      this.api('GET', '/categories'),
      this.api('GET', '/brands'),
      this.api('GET', '/branches'),
      this.api('GET', '/suppliers'),
      this.api('GET', '/units'),
    ]);
    this._uoms = uoms;
    const product = id ? await this.api('GET', `/products/${id}`) : null;
    const p = product || {};
    const defaultTax = p.tax_rate ?? this.settings?.tax_rate ?? 8.5;
    this._editingProductId = id || null;

    const detailsPanel = `
      <div class="input-row">
        <div class="form-group"><label>SKU *</label><input id="pf-sku" value="${this.escapeAttr(p.sku)}" placeholder="PROD-001"></div>
        <div class="form-group"><label>Barcode</label><input id="pf-barcode" value="${this.escapeAttr(p.barcode)}" placeholder="0001234567890"></div>
      </div>
      <div class="form-group"><label>Name *</label><input id="pf-name" value="${this.escapeAttr(p.name)}"></div>
      <div class="form-group"><label>Description</label><input id="pf-desc" value="${this.escapeAttr(p.description)}"></div>
      <div class="form-group"><label>Detailed Description <span style="font-size:11px;color:var(--text-muted);font-weight:400">(shown on the website)</span></label><textarea id="pf-long-desc" rows="5" placeholder="Features, specifications, what's included, care/usage notes…">${this.escapeAttr(p.long_description)}</textarea></div>
      <div class="input-row-3">
        <div class="form-group"><label>Category</label>
          <select id="pf-cat"><option value="">— None —</option>${categories.map(c => `<option value="${c.id}" ${p.category_id==c.id?'selected':''}>${c.name}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label>Supplier</label>
          <select id="pf-supplier" data-searchable><option value="">— None —</option>${suppliers.map(s => `<option value="${s.id}" ${p.supplier_id==s.id?'selected':''}>${s.name}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label>Brand</label>
          <select id="pf-brand">
            <option value="">— None —</option>
            ${brands.map(b => `<option value="${this.escapeAttr(b.name)}" ${p.brand===b.name?'selected':''}>${this.escapeAttr(b.name)}</option>`).join('')}
            ${p.brand && !brands.some(b => b.name === p.brand) ? `<option value="${this.escapeAttr(p.brand)}" selected>${this.escapeAttr(p.brand)} (not in Brands list)</option>` : ''}
          </select>
        </div>
      </div>
      <div class="input-row-3">
        <div class="form-group"><label>Price *</label><input type="number" id="pf-price" value="${p.price||0}" min="0" step="0.01"></div>
        <div class="form-group"><label>Cost</label><input type="number" id="pf-cost" value="${p.cost||0}" min="0" step="0.01"></div>
        <div class="form-group"><label>Tax Rate %</label><input type="number" id="pf-tax" value="${defaultTax}" min="0" step="0.1"></div>
      </div>
      ${this._pfUnitsSectionHtml(p)}
      <div class="input-row">
        ${id ? this._pfStockFieldHtml(p, branches, branchId) : `<div class="form-group"><label>Stock Qty</label><input type="number" id="pf-stock" value="${p.stock_qty||0}" min="0" oninput="App._updatePfBinSplitSummary()"></div>`}
        <div class="form-group"><label>Min Stock</label><input type="number" id="pf-minstock" value="${p.min_stock||5}" min="0"></div>
      </div>
      ${!id ? `<div class="form-group"><label>Assign to Branch <span style="color:var(--text-muted);font-weight:400;font-size:11px">(allocates initial stock to this branch)</span></label>
        <select id="pf-branch" onchange="App._onPfBranchChange()"><option value="">— No specific branch (global) —</option>${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}</select>
      </div>
      <div id="pf-bin-split-wrap" style="display:none;border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-weight:600;font-size:13px">Split Stock Into Bins <span style="font-weight:400;color:var(--text-muted);font-size:11px">(optional — for precise picking &amp; cycle counts)</span></div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="App._addPfBinRow()">+ Add Bin</button>
        </div>
        <div id="pf-bin-rows"></div>
        <div id="pf-bin-summary" style="font-size:12px;color:var(--text-muted);margin-top:6px"></div>
      </div>` : ''}
      <div class="form-group"><label>Status</label>
        <select id="pf-active"><option value="1" ${p.active!==0?'selected':''}>Active</option><option value="0" ${p.active===0?'selected':''}>Inactive</option></select>
      </div>
      <div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-top:4px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input type="checkbox" id="pf-online" ${p.online_available?'checked':''} onchange="document.getElementById('pf-web-allotment-wrap').style.display=this.checked?'':'none'" style="width:auto;margin:0">
          <label for="pf-online" style="margin:0;font-weight:500;cursor:pointer">Available for Online Sales</label>
        </div>
        <div id="pf-web-allotment-wrap" style="display:${p.online_available?'':'none'}">
          <div class="form-group" style="margin:0"><label>Web Sales Allotment <span style="font-weight:400;color:var(--text-muted)">(qty reserved for online — blank uses full stock)</span></label>
            <input type="number" id="pf-web-allotment" value="${p.web_allotment??''}" min="0" placeholder="Leave blank to use full stock qty">
          </div>
        </div>
      </div>
      <div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-top:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="pf-layaway" ${p.is_layaway_eligible?'checked':''} style="width:auto;margin:0">
          <label for="pf-layaway" style="margin:0;font-weight:500;cursor:pointer">Eligible for Layaway</label>
        </div>
      </div>
      ${id ? `<div class="form-group" style="margin-top:4px"><label>Product Image</label>
        <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
          ${p.image_path ? `<img src="${p.image_path}" class="prod-img-thumb" id="pf-img-preview" alt="">` : `<div class="prod-img-placeholder" id="pf-img-preview" onclick="document.getElementById('pf-img-input').click()">📷</div>`}
          <div>
            <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">Upload Image<input type="file" id="pf-img-input" accept="image/*" style="display:none" onchange="App.uploadProductImage(${id},this)"></label>
            ${p.image_path ? `<button class="btn btn-danger btn-sm" style="margin-left:6px" onclick="App.deleteProductImage(${id})">Remove</button>` : ''}
          </div>
        </div>
      </div>` : ''}`;

    this.showModal(`
      <div class="modal" style="${id ? 'max-width:700px' : ''}">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit Product' : 'Add Product'}</span>
          <button class="modal-close">✕</button>
        </div>
        ${id ? `<div class="var-tab-bar">
          <div class="var-tab active" id="ptab-details" onclick="App._switchProdTab('details')">Details</div>
          <div class="var-tab" id="ptab-variations" onclick="App._switchProdTab('variations')">Variations</div>
          <div class="var-tab" id="ptab-bins" onclick="App._switchProdTab('bins')">Bin Locations</div>
        </div>` : ''}
        <div id="ppanel-details" class="modal-body">${detailsPanel}</div>
        ${id ? `<div id="ppanel-variations" style="display:none;overflow-y:auto;max-height:520px"><div id="var-panel"><div style="text-align:center;padding:30px;color:var(--text-muted)">Click the Variations tab to manage variants</div></div></div>
        <div id="ppanel-bins" style="display:none;overflow-y:auto;max-height:520px"><div id="bin-panel"><div style="text-align:center;padding:30px;color:var(--text-muted)">Click the Bin Locations tab to manage bin assignments</div></div></div>` : ''}
        <div class="modal-footer">
          ${id ? `<button class="btn btn-danger" onclick="App.deleteProduct(${id})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="pf-save-btn" onclick="App.saveProduct(${id||'null'})">Save</button>
        </div>
      </div>`);
    this._pfRefreshUnitLabels();
  },

  _switchProdTab(tab) {
    ['details','variations','bins'].forEach(t => {
      document.getElementById(`ptab-${t}`)?.classList.toggle('active', t === tab);
      const panel = document.getElementById(`ppanel-${t}`);
      if (panel) panel.style.display = t === tab ? '' : 'none';
    });
    const saveBtn = document.getElementById('pf-save-btn');
    if (saveBtn) saveBtn.style.display = (tab === 'variations' || tab === 'bins') ? 'none' : '';
    if (tab === 'variations' && this._editingProductId) this.showVariationsPanel(this._editingProductId);
    if (tab === 'bins' && this._editingProductId) this.showBinLocationsPanel(this._editingProductId);
  },

  async uploadProductImage(productId, input) {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    try {
      const res = await fetch(`/api/products/${productId}/image`, { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      const preview = document.getElementById('pf-img-preview');
      if (preview) { preview.tagName === 'IMG' ? (preview.src = json.image_path) : Object.assign(preview, { tagName: undefined }); }
      this.alert('Image uploaded');
      this.showProductForm(productId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteProductImage(productId) {
    if (!confirm('Remove product image?')) return;
    try {
      await this.api('DELETE', `/products/${productId}/image`);
      this.alert('Image removed');
      this.showProductForm(productId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Same endpoint as uploadProductImage/deleteProductImage above, but reloads
  // the Rental Item form (not the retail Product form) afterward.
  async uploadRentalItemImage(productId, input) {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    try {
      const res = await fetch(`/api/products/${productId}/image`, { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      this.alert('Image uploaded');
      this.showRentalItemForm(productId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteRentalItemImage(productId) {
    if (!confirm('Remove rental item image?')) return;
    try {
      await this.api('DELETE', `/products/${productId}/image`);
      this.alert('Image removed');
      this.showRentalItemForm(productId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async saveProduct(id) {
    const data = {
      sku: document.getElementById('pf-sku').value.trim(),
      barcode: document.getElementById('pf-barcode').value.trim() || null,
      name: document.getElementById('pf-name').value.trim(),
      description: document.getElementById('pf-desc').value.trim() || null,
      long_description: document.getElementById('pf-long-desc').value.trim() || null,
      category_id: document.getElementById('pf-cat').value || null,
      supplier_id: document.getElementById('pf-supplier').value || null,
      brand: document.getElementById('pf-brand').value.trim() || null,
      price: parseFloat(document.getElementById('pf-price').value) || 0,
      cost: parseFloat(document.getElementById('pf-cost').value) || 0,
      tax_rate: parseFloat(document.getElementById('pf-tax').value) || 0,
      stock_qty: parseFloat(document.getElementById('pf-stock').value) || 0,
      min_stock: parseInt(document.getElementById('pf-minstock').value) || 5,
      active: parseInt(document.getElementById('pf-active').value),
      online_available: document.getElementById('pf-online').checked ? 1 : 0,
      web_allotment: document.getElementById('pf-web-allotment').value !== '' ? parseInt(document.getElementById('pf-web-allotment').value) : null,
      is_layaway_eligible: document.getElementById('pf-layaway').checked ? 1 : 0,
    };
    // Units of measure (lib/units.js): stock unit + alternate units.
    const units = this._pfReadUnits();
    if (typeof units === 'string') { this.alert(units, 'error'); return; }
    if (units) Object.assign(data, units);
    // An existing item's stock is only saved for the branch picked beside
    // it; on All Branches (the sum of the branches) it's left as it is.
    const stockBranchEl = document.getElementById('pf-stock-branch');
    if (id && stockBranchEl) {
      if (stockBranchEl.value) data.stock_branch_id = Number(stockBranchEl.value);
      else delete data.stock_qty;
    }
    let binRows = [];
    if (!id) {
      const branchEl = document.getElementById('pf-branch');
      if (branchEl) data.branch_id = branchEl.value || null;
      binRows = this._getPfBinRows();
      const totalBinQty = binRows.reduce((s, r) => s + r.quantity, 0);
      if (totalBinQty > data.stock_qty) {
        this.alert(`Bin quantities (${totalBinQty}) can't exceed stock qty (${data.stock_qty})`, 'error');
        return;
      }
    }
    try {
      let prod;
      if (id) prod = await this.api('PUT', `/products/${id}`, data);
      else prod = await this.api('POST', '/products', data);
      if (prod?.warning) this.alert(prod.warning, 'warning');
      if (!id && data.branch_id && binRows.length) {
        for (let i = 0; i < binRows.length; i++) {
          const row = binRows[i];
          try {
            await this.api('POST', '/warehouse/assignments', {
              product_id: prod.id, bin_id: row.bin_id, branch_id: data.branch_id,
              quantity: row.quantity, is_primary: i === 0,
            });
          } catch(e) { /* keep placing the remaining rows even if one bin fails */ }
        }
      }
      const filters = this._invFilterState({ search: data.sku || data.name, branchId: data.branch_id });
      this.closeModal();
      this.alert(id ? 'Product updated' : 'Product created');
      this.renderInventory(null, filters);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // Stock Qty on the edit form: a branch picker beside the count. All
  // Branches shows the total across branches, read-only; picking a branch
  // shows that branch's count and lets it be changed (saved as
  // stock_branch_id, logged as an adjustment).
  _pfStockFieldHtml(p, branches, branchId) {
    this._pfBranchStock = new Map((p.branch_stock || []).map(s => [String(s.branch_id), Number(s.stock_qty) || 0]));
    this._pfStockTotal = Number(p.stock_qty) || 0;
    const opts = branches.filter(b => b.active || this._pfBranchStock.has(String(b.id)))
      .map(b => `<option value="${b.id}" ${String(b.id) === String(branchId) ? 'selected' : ''}>${this.escapeAttr(b.name)} (${this._pfBranchStock.get(String(b.id)) ?? 0})</option>`).join('');
    const picked = branchId ? String(branchId) : '';
    const qty = picked ? (this._pfBranchStock.get(picked) ?? 0) : this._pfStockTotal;
    return `<div class="form-group"><label>Stock Qty</label>
      <div style="display:flex;gap:6px">
        <select id="pf-stock-branch" style="flex:1;min-width:0" onchange="App._pfStockBranchChange()"><option value="">All Branches (total)</option>${opts}</select>
        <input type="number" id="pf-stock" value="${qty}" min="0" style="width:100px" ${picked ? '' : 'disabled'}>
      </div>
      <div id="pf-stock-hint" style="font-size:11px;color:var(--text-muted);margin-top:4px">${picked ? 'Changes this branch\'s count only.' : 'Total of every branch — pick a branch to change its count.'}</div>
    </div>`;
  },

  _pfStockBranchChange() {
    const bid = document.getElementById('pf-stock-branch').value;
    const input = document.getElementById('pf-stock');
    input.value = bid ? (this._pfBranchStock.get(bid) ?? 0) : this._pfStockTotal;
    input.disabled = !bid;
    document.getElementById('pf-stock-hint').textContent = bid ? "Changes this branch's count only." : 'Total of every branch — pick a branch to change its count.';
    if (bid) input.focus();
  },

  // ─── Add-product bin split (initial stock) ──────────────────────────────

  async _onPfBranchChange() {
    const branchId = document.getElementById('pf-branch')?.value;
    const wrap = document.getElementById('pf-bin-split-wrap');
    const rowsEl = document.getElementById('pf-bin-rows');
    if (!wrap || !rowsEl) return;
    rowsEl.innerHTML = '';
    this._pfBins = [];
    if (!branchId) { wrap.style.display = 'none'; this._updatePfBinSplitSummary(); return; }
    this._pfBins = await this.api('GET', `/warehouse/bins?branch_id=${branchId}`);
    wrap.style.display = '';
    if (!this._pfBins.length) {
      rowsEl.innerHTML = `<p style="color:var(--text-muted);font-size:12px">No bins set up for this location yet. Add them in Warehouse → Bins.</p>`;
    }
    this._updatePfBinSplitSummary();
  },

  _pfBinRowHtml(binId = '', qty = '') {
    const bins = this._pfBins || [];
    return `<div class="input-row pf-bin-row" style="margin-bottom:6px">
      <select class="pf-bin-select" style="flex:1" onchange="App._updatePfBinSplitSummary()">
        <option value="">Select bin…</option>
        ${bins.map(b => `<option value="${b.id}" ${String(b.id)===String(binId)?'selected':''}>${b.bin_code}${b.zone_name?' — '+b.zone_name:''}</option>`).join('')}
      </select>
      <input type="number" class="pf-bin-qty" min="0" value="${qty}" placeholder="Qty" style="max-width:90px" oninput="App._updatePfBinSplitSummary()">
      <button type="button" class="btn btn-danger btn-sm" onclick="this.closest('.pf-bin-row').remove();App._updatePfBinSplitSummary()">✕</button>
    </div>`;
  },

  _addPfBinRow() {
    const rowsEl = document.getElementById('pf-bin-rows');
    if (!rowsEl || !(this._pfBins||[]).length) return;
    const div = document.createElement('div');
    div.innerHTML = this._pfBinRowHtml();
    rowsEl.appendChild(div.firstElementChild);
  },

  _getPfBinRows() {
    return Array.from(document.querySelectorAll('#pf-bin-rows .pf-bin-row')).map(row => ({
      bin_id: row.querySelector('.pf-bin-select')?.value || '',
      quantity: parseInt(row.querySelector('.pf-bin-qty')?.value) || 0,
    })).filter(r => r.bin_id && r.quantity > 0);
  },

  _updatePfBinSplitSummary() {
    const summary = document.getElementById('pf-bin-summary');
    if (!summary) return;
    const stockQty = parseInt(document.getElementById('pf-stock')?.value) || 0;
    const assigned = this._getPfBinRows().reduce((sum, r) => sum + r.quantity, 0);
    const remaining = stockQty - assigned;
    summary.style.color = remaining < 0 ? 'var(--danger)' : 'var(--text-muted)';
    summary.textContent = remaining < 0
      ? `Over-allocated by ${-remaining} — bin quantities can't exceed stock qty (${stockQty})`
      : `${assigned} of ${stockQty} allocated to bins${remaining > 0 ? ` — ${remaining} unassigned` : ''}`;
  },

  // ─── Edit-product Bin Locations panel ────────────────────────────────────

  async showBinLocationsPanel(productId) {
    const panel = document.getElementById('bin-panel');
    if (!panel) return;
    panel.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Loading...</div>';
    const branches = await this.api('GET', '/branches');
    this._binPanelBranches = branches.filter(b => b.active);
    this._binPanelProductId = productId;
    if (!this._binPanelBranches.length) {
      panel.innerHTML = '<p style="padding:16px;color:var(--text-muted);font-size:13px">No active locations configured. Add one in Branches first.</p>';
      return;
    }
    const branchId = this._binPanelBranchId || this._binPanelBranches[0].id;
    await this._renderBinLocationsBody(productId, branchId);
  },

  async _renderBinLocationsBody(productId, branchId) {
    const panel = document.getElementById('bin-panel');
    if (!panel) return;
    this._binPanelBranchId = branchId;
    const [product, assignments, bins] = await Promise.all([
      this.api('GET', `/products/${productId}?branch_id=${branchId}`),
      this.api('GET', `/warehouse/assignments?product_id=${productId}&branch_id=${branchId}`),
      this.api('GET', `/warehouse/bins?branch_id=${branchId}`),
    ]);
    this._binPanelAssignments = assignments;
    this._binPanelBranchStock = product.branch_stock_qty || 0;
    const branchStock = this._binPanelBranchStock;
    const assigned = assignments.reduce((s, a) => s + a.quantity, 0);
    const remaining = branchStock - assigned;
    const unassignedBins = bins.filter(b => !assignments.some(a => a.bin_id === b.id));
    panel.innerHTML = `
      <div style="padding:16px;border-bottom:1px solid var(--border)">
        <div class="form-group" style="margin-bottom:10px"><label>Location</label>
          <select id="binp-branch" style="max-width:260px">
            ${this._binPanelBranches.map(b => `<option value="${b.id}" ${String(b.id)===String(branchId)?'selected':''}>${b.name}</option>`).join('')}
          </select>
        </div>
        <div style="font-size:13px;color:${remaining<0?'var(--danger)':'var(--text-muted)'}">
          Branch stock: <strong>${branchStock}</strong> &nbsp;·&nbsp; Assigned to bins: <strong>${assigned}</strong>
          ${remaining < 0 ? ` &nbsp;·&nbsp; <strong>Over-allocated by ${-remaining}</strong>` : remaining > 0 ? ` &nbsp;·&nbsp; ${remaining} unassigned` : ' &nbsp;·&nbsp; fully allocated'}
        </div>
      </div>
      <div style="padding:16px">
        ${bins.length === 0 ? `<p style="color:var(--text-muted);font-size:13px">No bins set up for this location. Add them in Warehouse → Bins.</p>` : ''}
        ${assignments.length ? `<table class="table"><thead><tr><th>Bin</th><th>Zone</th><th>Qty</th><th>Primary</th><th></th></tr></thead>
          <tbody>${assignments.map(a => `
          <tr>
            <td><strong>${a.bin_code}</strong></td>
            <td style="color:var(--text-muted)">${a.zone_name||'—'}</td>
            <td><input type="number" min="0" value="${a.quantity}" style="width:80px" onchange="App._updateBinLocQty(${a.id},this.value)"></td>
            <td>${a.is_primary ? '<span class="badge-pill badge-success">Primary</span>' : `<button class="btn btn-secondary btn-sm" onclick="App._makeBinLocPrimary(${a.id})">Make Primary</button>`}</td>
            <td><button class="btn btn-danger btn-sm" onclick="App._removeBinLoc(${a.id})">Remove</button></td>
          </tr>`).join('')}</tbody></table>`
          : '<div class="empty-state"><p>No bins assigned yet at this location.</p></div>'}
        ${unassignedBins.length ? `
        <div style="display:flex;gap:8px;align-items:flex-end;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
          <div class="form-group" style="margin:0;flex:1"><label>Add Bin</label>
            <select id="binp-new-bin">${unassignedBins.map(b => `<option value="${b.id}">${b.bin_code}${b.zone_name?' — '+b.zone_name:''}</option>`).join('')}</select>
          </div>
          <div class="form-group" style="margin:0"><label>Qty</label><input type="number" id="binp-new-qty" min="0" value="0" style="width:90px"></div>
          <button class="btn btn-primary btn-sm" onclick="App._addBinLoc()">Add</button>
        </div>` : ''}
      </div>`;
    const branchSel = document.getElementById('binp-branch');
    if (branchSel) branchSel.onchange = (e) => this._renderBinLocationsBody(productId, e.target.value);
  },

  async _addBinLoc() {
    const binId = document.getElementById('binp-new-bin')?.value;
    const qty = parseInt(document.getElementById('binp-new-qty')?.value) || 0;
    if (!binId || qty <= 0) return this.alert('Select a bin and enter a quantity greater than 0', 'warning');
    const branchStock = this._binPanelBranchStock || 0;
    const currentlyAssigned = (this._binPanelAssignments||[]).reduce((s,a) => s + a.quantity, 0);
    if (currentlyAssigned + qty > branchStock) {
      return this.alert(`Only ${branchStock - currentlyAssigned} unit(s) unassigned at this location — reduce the quantity`, 'error');
    }
    try {
      await this.api('POST', '/warehouse/assignments', {
        product_id: this._binPanelProductId, bin_id: binId, branch_id: this._binPanelBranchId,
        quantity: qty, is_primary: !(this._binPanelAssignments||[]).length,
      });
      this._renderBinLocationsBody(this._binPanelProductId, this._binPanelBranchId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _updateBinLocQty(assignmentId, qty) {
    const q = parseInt(qty) || 0;
    const branchStock = this._binPanelBranchStock || 0;
    const others = (this._binPanelAssignments||[]).filter(a => a.id !== assignmentId).reduce((s,a) => s + a.quantity, 0);
    if (others + q > branchStock) {
      this.alert(`Total would exceed branch stock (${branchStock}) — reduce the quantity`, 'error');
      this._renderBinLocationsBody(this._binPanelProductId, this._binPanelBranchId);
      return;
    }
    const existing = (this._binPanelAssignments||[]).find(a => a.id === assignmentId);
    try {
      await this.api('PUT', `/warehouse/assignments/${assignmentId}`, { quantity: q, is_primary: !!existing?.is_primary });
      this._renderBinLocationsBody(this._binPanelProductId, this._binPanelBranchId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _makeBinLocPrimary(assignmentId) {
    try {
      const others = (this._binPanelAssignments||[]).filter(a => a.is_primary && a.id !== assignmentId);
      for (const o of others) {
        await this.api('PUT', `/warehouse/assignments/${o.id}`, { quantity: o.quantity, is_primary: false });
      }
      const target = (this._binPanelAssignments||[]).find(a => a.id === assignmentId);
      await this.api('PUT', `/warehouse/assignments/${assignmentId}`, { quantity: target?.quantity||0, is_primary: true });
      this._renderBinLocationsBody(this._binPanelProductId, this._binPanelBranchId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _removeBinLoc(assignmentId) {
    if (!confirm('Remove this bin assignment?')) return;
    try {
      await this.api('DELETE', `/warehouse/assignments/${assignmentId}`);
      this._renderBinLocationsBody(this._binPanelProductId, this._binPanelBranchId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteProduct(id) {
    if (!confirm('Deactivate this product?')) return;
    await this.api('DELETE', `/products/${id}`);
    const filters = this._invFilterState();
    this.closeModal();
    this.alert('Product deactivated');
    this.renderInventory(null, filters);
  },

  // ─── Services & Non-Inventory Items ─────────────────────────────────────

  // Services filter bar as it stands, so a save / deactivate re-renders on the
  // same search; `fallback` fills the search only when it was empty.
  _svcFilterState(fallback = {}) {
    const val = id => (document.getElementById(id) || {}).value || '';
    return {
      search: val('svc-search') || fallback.search || '',
      category: val('svc-cat-filter'),
      status: val('svc-status-filter'),
    };
  },

  async renderServices(filters = null) {
    const hasFilters = !!(filters && (filters.search || filters.category || filters.status));
    const [services, categories] = await Promise.all([
      // refilter() below fetches the filtered list when filters are restored.
      hasFilters ? [] : this.api('GET', '/products?is_service=1'),
      this.api('GET', '/categories'),
    ]);
    if (this.section !== 'services') return;
    const c = document.getElementById('content');
    c.innerHTML = `
      <div class="section-header">
        <h2>Services &amp; Non-Inventory Items</h2>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <a class="btn btn-secondary btn-sm" href="/api/products/export/services" download title="Export all services to CSV — the file can be imported straight into another server">&#8659; Export CSV</a>
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0" title="Import services from CSV or Excel — updates matching SKUs, creates the rest">&#8657; Import<input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="display:none" onchange="App.importServicesCsv(this)"></label>
          <button class="btn btn-primary" onclick="App.showServiceForm()">+ Add Service</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <div class="search-bar" style="flex:0 0 auto">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" id="svc-search" placeholder="Search services..." style="width:220px">
        </div>
        <select id="svc-cat-filter" style="width:auto;min-width:140px"><option value="">All Categories</option>${categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
        <select id="svc-status-filter" style="width:auto;min-width:120px">
          <option value="">All Statuses</option>
          <option value="1">Active</option>
          <option value="0">Inactive</option>
        </select>
      </div>
      <div class="card">
        <div class="table-wrap" id="svc-table-wrap">
          ${hasFilters ? '<p style="color:var(--text-muted);padding:16px">Loading…</p>' : this._buildServiceTable(services)}
        </div>
      </div>`;

    // Only the latest request may paint the table (see renderInventory).
    let refilterSeq = 0;
    const refilter = async () => {
      const seq = ++refilterSeq;
      const q = document.getElementById('svc-search').value.trim();
      const cat = document.getElementById('svc-cat-filter').value;
      const status = document.getElementById('svc-status-filter').value;
      let url = '/products?is_service=1&';
      if (q) url += `search=${encodeURIComponent(q)}&`;
      if (cat) url += `category=${cat}&`;
      if (status !== '') url += `active=${status}&`;
      const filtered = await this.api('GET', url);
      if (seq !== refilterSeq || this.section !== 'services') return;
      document.getElementById('svc-table-wrap').innerHTML = this._buildServiceTable(filtered);
    };

    let searchTimer;
    const searchEl = document.getElementById('svc-search');
    searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refilter, 250); });
    searchEl.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); refilter(); } });
    document.getElementById('svc-cat-filter').addEventListener('change', refilter);
    document.getElementById('svc-status-filter').addEventListener('change', refilter);

    if (hasFilters) {
      searchEl.value = filters.search || '';
      document.getElementById('svc-cat-filter').value = filters.category || '';
      document.getElementById('svc-status-filter').value = filters.status || '';
      await refilter();
    }
  },

  _buildServiceTable(services) {
    if (!services.length) return '<p style="color:var(--text-muted);padding:16px">No services found.</p>';
    return `<table>
      <thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Unit</th><th>Price</th><th>Cost</th><th>Tax %</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${services.map(s => `<tr>
          <td class="fw-600">${s.sku}</td>
          <td>${s.name}${s.description ? `<div style="font-size:11px;color:var(--text-muted)">${s.description}</div>` : ''}</td>
          <td>${s.category_name || '—'}</td>
          <td style="color:var(--text-muted)">${s.unit || '—'}</td>
          <td class="fw-600">${this.fmt(s.price)}</td>
          <td>${s.cost ? this.fmt(s.cost) : '—'}</td>
          <td>${s.tax_rate}%</td>
          <td><span class="badge-pill ${s.active ? 'badge-success' : 'badge-danger'}">${s.active ? 'Active' : 'Inactive'}</span></td>
          <td><button class="btn btn-sm btn-secondary" onclick="App.showServiceForm(${s.id})">Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  },

  async showServiceForm(id) {
    const [categories, s] = await Promise.all([
      this.api('GET', '/categories'),
      id ? this.api('GET', `/products/${id}`) : Promise.resolve({}),
    ]);
    const defaultTax = s.tax_rate ?? this.settings?.tax_rate ?? 8.5;
    const unitOptions = ['Flat Fee','Per Hour','Per Visit','Per Day','Per Unit','Per Month','Per Year'];

    this.showModal(`
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit Service' : 'Add Service'}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>SKU *</label><input id="sf-sku" value="${this.escapeAttr(s.sku)}" placeholder="SVC-001"></div>
            <div class="form-group"><label>Unit / Billing Type</label>
              <select id="sf-unit">
                <option value="">— None —</option>
                ${unitOptions.map(u => `<option value="${u}" ${s.unit===u?'selected':''}>${u}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group"><label>Name *</label><input id="sf-name" value="${this.escapeAttr(s.name)}"></div>
          <div class="form-group"><label>Description</label><input id="sf-desc" value="${this.escapeAttr(s.description)}"></div>
          <div class="form-group"><label>Category</label>
            <select id="sf-cat"><option value="">— None —</option>${categories.map(c => `<option value="${c.id}" ${s.category_id==c.id?'selected':''}>${c.name}</option>`).join('')}</select>
          </div>
          <div class="input-row-3">
            <div class="form-group"><label>Price *</label><input type="number" id="sf-price" value="${s.price||0}" min="0" step="0.01"></div>
            <div class="form-group"><label>Cost</label><input type="number" id="sf-cost" value="${s.cost||0}" min="0" step="0.01"></div>
            <div class="form-group"><label>Tax Rate %</label><input type="number" id="sf-tax" value="${defaultTax}" min="0" step="0.1"></div>
          </div>
          <div class="form-group"><label>Status</label>
            <select id="sf-active"><option value="1" ${s.active!==0?'selected':''}>Active</option><option value="0" ${s.active===0?'selected':''}>Inactive</option></select>
          </div>
        </div>
        <div class="modal-footer">
          ${id ? `<button class="btn btn-danger" onclick="App.deleteService(${id})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveService(${id||'null'})">Save</button>
        </div>
      </div>`);
  },

  async saveService(id) {
    const sku = document.getElementById('sf-sku').value.trim();
    const name = document.getElementById('sf-name').value.trim();
    if (!sku || !name) { this.alert('SKU and name are required', 'error'); return; }
    const data = {
      sku,
      name,
      description: document.getElementById('sf-desc').value.trim() || null,
      category_id: document.getElementById('sf-cat').value || null,
      unit: document.getElementById('sf-unit').value || null,
      price: parseFloat(document.getElementById('sf-price').value) || 0,
      cost: parseFloat(document.getElementById('sf-cost').value) || 0,
      tax_rate: parseFloat(document.getElementById('sf-tax').value) || 0,
      active: parseInt(document.getElementById('sf-active').value),
      is_service: 1,
    };
    try {
      if (id) await this.api('PUT', `/products/${id}`, data);
      else await this.api('POST', '/products', data);
      const filters = this._svcFilterState({ search: sku });
      this.closeModal();
      this.alert(id ? 'Service updated' : 'Service created');
      this.renderServices(filters);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async importServicesCsv(inputEl) {
    const file = inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await this._readImportFile(file); } catch (e) { this.alert(e.message, 'error'); return; }
    const { headers, rows: rawRows } = parsed;
    if (!rawRows.length) { this.alert('No data rows found in CSV', 'error'); return; }

    const mapping = await this._showFieldMappingModal({ title: 'Map Import Columns', headers, fields: this._serviceImportFields });
    if (!mapping) return;
    const rows = this._remapCsvRows(rawRows, mapping);

    await this._runBatchedCsvImport({
      rows, endpoint: '/products/import/services', title: 'Importing Services',
      summarize: t => `${t.created||0} created, ${t.updated||0} updated${t.categories_created ? `, ${t.categories_created} new categor${t.categories_created === 1 ? 'y' : 'ies'} added` : ''}`,
      onFinish: () => this.renderServices(),
    });
  },

  async deleteService(id) {
    if (!confirm('Deactivate this service?')) return;
    await this.api('DELETE', `/products/${id}`);
    const filters = this._svcFilterState();
    this.closeModal();
    this.alert('Service deactivated');
    this.renderServices(filters);
  },

  // ─── Stock adjust, image scan and bulk branch / tax-rate tools ────
  // From All Branches (no branchId) the dialog asks which branch to adjust —
  // the All Branches figure is the sum of the branches, not set directly.
  async showStockAdjust(id, name, current, branchId = '', branchName = '') {
    this._stockAdjustName = name;
    let branchPick = '';
    if (!branchId) {
      try {
        const [p, branches] = await Promise.all([this.api('GET', `/products/${id}`), this.api('GET', '/branches')]);
        this._stockAdjustBranchQty = new Map((p.branch_stock || []).map(s => [String(s.branch_id), Number(s.stock_qty) || 0]));
        const opts = branches.filter(b => b.active || this._stockAdjustBranchQty.has(String(b.id)))
          .map(b => `<option value="${b.id}">${this.escapeAttr(b.name)} (${this._stockAdjustBranchQty.get(String(b.id)) ?? 0})</option>`).join('');
        branchPick = `<div class="form-group"><label>Branch *</label><select id="stock-adj-branch" onchange="document.getElementById('stock-adj-current').textContent = this.value ? (App._stockAdjustBranchQty.get(this.value) ?? 0) : '${current}'"><option value="">Choose a branch…</option>${opts}</select></div>`;
      } catch(e) { this.alert(e.message, 'error'); return; }
    }
    const branchNote = branchName ? `<p style="margin-bottom:8px;color:var(--text-muted);font-size:12px">Branch: <strong>${branchName}</strong></p>` : '';
    this.showModal(`
      <div class="modal" style="max-width:360px">
        <div class="modal-header"><span class="modal-title">Adjust Stock: ${name}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${branchNote}
          ${branchPick}
          <p style="margin-bottom:12px;color:var(--text-muted)">Current stock${branchId ? '' : ' (all branches until one is chosen)'}: <strong id="stock-adj-current">${current}</strong></p>
          <div class="form-group"><label>Adjustment (+/-)</label><input type="number" id="stock-adj" placeholder="e.g. +10 or -5"></div>
          <div class="form-group"><label>Reason</label><input id="stock-reason" placeholder="Receiving, shrinkage, etc."></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.applyStockAdjust(${id},${branchId || 'null'})">Apply</button>
        </div>
      </div>`);
  },

  async applyStockAdjust(id, branchId = null) {
    const adj = parseInt(document.getElementById('stock-adj').value);
    const reason = document.getElementById('stock-reason').value;
    if (isNaN(adj)) { this.alert('Enter a valid number', 'error'); return; }
    const picker = document.getElementById('stock-adj-branch');
    if (picker) {
      if (!picker.value) { this.alert('Choose the branch to adjust', 'error'); return; }
      branchId = Number(picker.value);
    }
    try { await this.api('PATCH', `/products/${id}/stock`, { adjustment: adj, reason, branch_id: branchId || null }); }
    catch(e) { this.alert(e.message, 'error'); return; }
    const filters = this._invFilterState({ search: this._stockAdjustName, branchId: picker ? undefined : branchId });
    this.closeModal();
    this.alert('Stock updated');
    this.renderInventory(null, filters);
  },

  async scanProductImages() {
    if (!confirm('Scan uploads/products/ for image files named after a SKU (e.g. "ABC123.jpg") and assign each to its matching product? This replaces any image that product already has.')) return;
    try {
      const result = await this.api('POST', '/products/images/scan-folder');
      let msg = `Scanned ${result.scanned} image file(s), matched ${result.matched} to a product.`;
      if (result.matched) msg += `\n\n${result.details.map(d => `${d.sku} ← ${d.file}`).join('\n')}`;
      this.alert(msg, result.matched ? 'success' : 'warning');
      this.renderInventory();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // A plain CSV import only ever sets products.stock_qty (the "All
  // Branches" figure) — it never touches branch_inventory, so every
  // branch-filtered view (and POS with a branch selected) shows 0 stock for
  // everything just imported. This bulk-assigns that stock to one chosen
  // branch — batched with a progress bar (_runBatchedCsvImport) rather than
  // one request for potentially thousands of products — instead of editing
  // each product by hand.
  async showBulkAssignBranchModal() {
    const [{ count, ids }, branches] = await Promise.all([
      this.api('GET', '/products/unbranched-count'),
      this.api('GET', '/branches'),
    ]);
    this._bulkAssignIds = ids;
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Bulk Assign to Branch</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${count > 0
            ? `<p style="font-size:13px;color:var(--text-muted);margin-bottom:12px"><strong>${count}</strong> active retail product(s) have no branch stock assigned yet (their quantity currently only shows under "All Branches"). Choose a branch to assign all of it to:</p>
               <div class="form-group"><label>Branch</label><select id="bab-branch"><option value="">Select a branch...</option>${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}</select></div>
               <p style="font-size:12px;color:var(--text-muted)">Products already assigned to (or split across) a branch are left untouched — this only fills in the gap.</p>`
            : `<p style="font-size:13px;color:var(--text-muted)">Every active retail product already has branch stock assigned — nothing to do.</p>`}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">${count > 0 ? 'Cancel' : 'Close'}</button>
          ${count > 0 ? `<button class="btn btn-primary" onclick="App.runBulkAssignBranch(${count})">Assign</button>` : ''}
        </div>
      </div>`);
  },

  async runBulkAssignBranch(count) {
    const branch_id = document.getElementById('bab-branch').value;
    if (!branch_id) { this.alert('Select a branch first', 'error'); return; }
    const branchName = document.getElementById('bab-branch').selectedOptions[0].textContent;
    if (!confirm(`Assign all ${count} unbranched product(s)' current stock quantity to ${branchName}?`)) return;
    await this._runBatchedCsvImport({
      rows: this._bulkAssignIds || [],
      endpoint: '/products/bulk-assign-branch',
      title: 'Assigning Products to Branch',
      extraBody: { branch_id },
      actionVerb: 'Assignment', actionVerbPast: 'Assigned', itemLabel: 'product(s)',
      summarize: totals => `${totals.assigned || 0} product(s) assigned to ${branchName}`,
      onFinish: () => this.renderInventory(),
    });
  },

  // Branch-scoped bulk tax-rate override — every active product stocked at
  // the chosen branch (retail, rental, or non-inventory — anything with a
  // branch_inventory row there) gets its tax_rate overwritten in one shot.
  // The product count only refreshes on branch change so it stays accurate
  // even if the modal's left open a while.
  async showBulkTaxRateModal() {
    const branches = await this.api('GET', '/branches');
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Bulk Tax Rate Change</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Overwrite the tax rate on every active product currently stocked at one branch — retail, rental, and non-inventory items alike.</p>
          <div class="form-group"><label>Branch</label>
            <select id="btr-branch" onchange="App._refreshBulkTaxRateCount()"><option value="">Select a branch...</option>${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>New Tax Rate %</label><input type="number" id="btr-rate" min="0" step="0.1" value="${this.settings?.tax_rate ?? 8.5}"></div>
          <p id="btr-count" style="font-size:12px;color:var(--text-muted)">Select a branch to see how many products this affects.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.runBulkTaxRate()">Apply</button>
        </div>
      </div>`);
  },

  async _refreshBulkTaxRateCount() {
    const branch_id = document.getElementById('btr-branch')?.value;
    const countEl = document.getElementById('btr-count');
    if (!countEl) return;
    if (!branch_id) { countEl.textContent = 'Select a branch to see how many products this affects.'; return; }
    countEl.textContent = 'Loading…';
    try {
      const { count } = await this.api('GET', `/products/branch-count/${branch_id}`);
      countEl.textContent = `${count} active product(s) are stocked at this branch and will be updated.`;
    } catch(e) { countEl.textContent = ''; }
  },

  async runBulkTaxRate() {
    const branchSel = document.getElementById('btr-branch');
    const branch_id = branchSel.value;
    const tax_rate = document.getElementById('btr-rate').value;
    if (!branch_id) { this.alert('Select a branch first', 'error'); return; }
    if (tax_rate === '' || parseFloat(tax_rate) < 0) { this.alert('Enter a valid tax rate', 'error'); return; }
    const branchName = branchSel.selectedOptions[0].textContent;
    if (!confirm(`Set every product stocked at ${branchName} to ${tax_rate}% tax? This overwrites their current tax rate and can't be undone in bulk.`)) return;
    try {
      const result = await this.api('POST', '/products/bulk-tax-rate', { branch_id, tax_rate });
      this.alert(`Updated tax rate on ${result.updated} product(s) at ${branchName}.`, 'success');
      this.closeModal();
      this.renderInventory();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Rental-items counterpart to the retail bulk tax-rate change above —
  // scoped to is_rental=1 only, and unlike the retail one, "All Branches" is
  // a real option here (not just a per-branch choice), since a rental
  // item's single branch assignment makes "every rental item everywhere"
  // just as meaningful a bulk target as "every rental item at one branch."
  async showBulkRentalTaxRateModal() {
    const branches = await this.api('GET', '/branches');
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Bulk Tax Rate Change — Rental Items</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Overwrite the tax rate on every active rental item — across all branches, or just one.</p>
          <div class="form-group"><label>Branch</label>
            <select id="brtr-branch" onchange="App._refreshBulkRentalTaxRateCount()">
              <option value="">All Branches</option>
              ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>New Tax Rate %</label><input type="number" id="brtr-rate" min="0" step="0.1" value="${this.settings?.tax_rate ?? 8.5}"></div>
          <p id="brtr-count" style="font-size:12px;color:var(--text-muted)">Loading…</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.runBulkRentalTaxRate()">Apply</button>
        </div>
      </div>`);
    this._refreshBulkRentalTaxRateCount();
  },

  async _refreshBulkRentalTaxRateCount() {
    const branch_id = document.getElementById('brtr-branch')?.value;
    const countEl = document.getElementById('brtr-count');
    if (!countEl) return;
    countEl.textContent = 'Loading…';
    try {
      const qs = branch_id ? `?branch_id=${branch_id}` : '';
      const { count } = await this.api('GET', `/products/rental-tax-count${qs}`);
      countEl.textContent = branch_id
        ? `${count} active rental item(s) are assigned to this branch and will be updated.`
        : `${count} active rental item(s) will be updated across all branches.`;
    } catch(e) { countEl.textContent = ''; }
  },

  async runBulkRentalTaxRate() {
    const branchSel = document.getElementById('brtr-branch');
    const branch_id = branchSel.value || null;
    const tax_rate = document.getElementById('brtr-rate').value;
    if (tax_rate === '' || parseFloat(tax_rate) < 0) { this.alert('Enter a valid tax rate', 'error'); return; }
    const branchName = branch_id ? branchSel.selectedOptions[0].textContent : 'All Branches';
    if (!confirm(`Set every active rental item${branch_id ? ` at ${branchName}` : ''} to ${tax_rate}% tax? This overwrites their current tax rate and can't be undone in bulk.`)) return;
    try {
      const result = await this.api('POST', '/products/bulk-tax-rate-rentals', { branch_id, tax_rate });
      this.alert(`Updated tax rate on ${result.updated} rental item(s)${branch_id ? ` at ${branchName}` : ' across all branches'}.`, 'success');
      this.closeModal();
      this.loadRentalItems();
    } catch(e) { this.alert(e.message, 'error'); }
  },
});
