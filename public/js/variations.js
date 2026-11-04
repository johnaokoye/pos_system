// Product variations, POS variation picker, stock adjust, bulk branch and tax-rate tools.
Object.assign(App, {
  // ─── Variation Management ────────────────────────────────────────────────

  async showVariationsPanel(productId) {
    const panel = document.getElementById('var-panel');
    if (!panel) return;
    panel.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Loading...</div>';

    const [types, variations, product] = await Promise.all([
      this.api('GET', `/products/${productId}/variation-types`),
      this.api('GET', `/products/${productId}/variations`),
      this.api('GET', `/products/${productId}`),
    ]);
    this._panelVariations = variations;
    this._panelProduct = product;

    panel.innerHTML = `
      <div style="padding:16px;border-bottom:1px solid var(--border)">
        <div style="font-weight:600;font-size:13px;margin-bottom:10px">Attribute Types <span style="font-weight:400;color:var(--text-muted);font-size:12px">— define dimensions like Size, Color, Material</span></div>
        <div id="var-types-list">
          ${types.map((t, i) => this._varTypeRowHtml(t.name, JSON.parse(t.attr_values||'[]').join(', '), i)).join('')}
        </div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn-secondary btn-sm" onclick="App._addVarTypeRow()">+ Add Attribute</button>
          <button class="btn btn-primary btn-sm" onclick="App._saveVariationTypes(${productId})">Save Attributes</button>
          <button class="btn btn-outline btn-sm" onclick="App._generateVariations(${productId})" title="Generate all attribute combinations as variations">⚡ Generate Variants</button>
        </div>
      </div>
      <div style="padding:16px">
        <div style="font-weight:600;font-size:13px;margin-bottom:10px">Variants <span style="color:var(--text-muted);font-weight:400;font-size:12px">(${variations.length})</span></div>
        ${variations.length ? this._buildVariationsTable(variations, product, productId) : '<p style="color:var(--text-muted);font-size:13px">No variants yet. Define attributes above then click ⚡ Generate Variants.</p>'}
      </div>`;
  },

  _varTypeRowHtml(name, values, idx) {
    return `<div class="var-type-row">
      <input placeholder="Attribute (e.g. Size)" value="${this.escapeAttr(name)}" class="var-type-name" style="flex:0 0 130px">
      <input placeholder="Values, comma-separated (e.g. S, M, L, XL)" value="${this.escapeAttr(values)}" class="var-type-values" style="flex:1">
      <button class="btn btn-danger btn-sm" onclick="this.closest('.var-type-row').remove()">✕</button>
    </div>`;
  },

  _addVarTypeRow() {
    const list = document.getElementById('var-types-list');
    if (!list) return;
    const div = document.createElement('div');
    div.innerHTML = this._varTypeRowHtml('', '', list.children.length);
    list.appendChild(div.firstElementChild);
  },

  _getTypesFromDOM() {
    const rows = document.querySelectorAll('#var-types-list .var-type-row');
    const types = [];
    rows.forEach(row => {
      const name = row.querySelector('.var-type-name')?.value?.trim();
      const valStr = row.querySelector('.var-type-values')?.value?.trim();
      if (name && valStr) {
        const values = valStr.split(',').map(v => v.trim()).filter(Boolean);
        if (values.length) types.push({ name, values });
      }
    });
    return types;
  },

  async _saveVariationTypes(productId) {
    const types = this._getTypesFromDOM();
    try {
      await this.api('PUT', `/products/${productId}/variation-types`, { types });
      this.alert('Attributes saved');
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _generateVariations(productId) {
    const types = this._getTypesFromDOM();
    if (!types.length) { this.alert('Define at least one attribute type first', 'warning'); return; }
    await this.api('PUT', `/products/${productId}/variation-types`, { types });
    const [existing, product] = await Promise.all([
      this.api('GET', `/products/${productId}/variations`),
      this.api('GET', `/products/${productId}`),
    ]);
    const existingAttrs = new Set(existing.map(v => v.attributes));
    const combos = types.reduce((acc, type) => {
      if (!acc.length) return type.values.map(v => [{ type: type.name, value: v }]);
      return acc.flatMap(prev => type.values.map(v => [...prev, { type: type.name, value: v }]));
    }, []);
    let created = 0;
    for (const combo of combos) {
      const attrs = Object.fromEntries(combo.map(c => [c.type, c.value]));
      if (existingAttrs.has(JSON.stringify(attrs))) continue;
      const name = combo.map(c => c.value).join(' / ');
      const suffix = combo.map(c => c.value.toUpperCase().replace(/[^A-Z0-9]/g, '')).join('-');
      const sku = `${product.sku}-${suffix}`;
      try { await this.api('POST', `/products/${productId}/variations`, { name, sku, attributes: attrs, stock_qty: 0 }); created++; } catch(e) {}
    }
    this.alert(created ? `Generated ${created} new variant${created !== 1 ? 's' : ''}` : 'All combinations already exist');
    this.showVariationsPanel(productId);
  },

  _buildVariationsTable(variations, product, productId) {
    return `<div class="table-wrap" style="max-height:300px;overflow-y:auto"><table>
      <thead><tr><th>Variant</th><th>SKU</th><th>Effective Price</th><th>Price Modifier</th><th>Cost</th><th>Stock</th><th>Active</th><th></th></tr></thead>
      <tbody id="var-tbody">
        ${variations.map(v => this._varRow(v, product, productId)).join('')}
      </tbody>
    </table></div>`;
  },

  _varRow(v, product, productId) {
    const effPrice = v.price != null ? v.price : parseFloat((product.price + (v.price_modifier || 0)).toFixed(2));
    const modLabel = v.price != null ? 'Fixed' : (v.price_modifier > 0 ? `+${this.fmt(v.price_modifier)}` : v.price_modifier < 0 ? `-${this.fmt(Math.abs(v.price_modifier))}` : '—');
    return `<tr id="vrow-${v.id}">
      <td class="fw-600">${v.name}</td>
      <td style="font-family:monospace;font-size:12px">${v.sku}</td>
      <td>${this.fmt(effPrice)}</td>
      <td style="color:var(--text-muted);font-size:12px">${modLabel}</td>
      <td style="color:var(--text-muted)">${v.cost != null ? this.fmt(v.cost) : '—'}</td>
      <td><span class="${v.stock_qty <= 0 ? 'color-danger fw-600' : ''}">${v.stock_qty}</span></td>
      <td><span class="badge-pill ${v.active ? 'badge-success' : 'badge-danger'}">${v.active ? 'Yes' : 'No'}</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary btn-sm" onclick="App._inlineEditVariation(${productId},${v.id})">Edit</button>
        ${this.can('inventory_adjust') ? `<button class="btn btn-outline btn-sm" onclick="App._varStockAdjust(${productId},${v.id},${this.escapeAttr(JSON.stringify(v.name))},${Number(v.stock_qty) || 0})">Stock</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="App._deleteVariation(${productId},${v.id})">✕</button>
      </td>
    </tr>`;
  },

  _inlineEditVariation(productId, variationId) {
    const row = document.getElementById(`vrow-${variationId}`);
    if (!row || row.dataset.editing) return;
    row.dataset.editing = '1';
    const v = this._panelVariations?.find(x => x.id === variationId) || {};
    row.innerHTML = `
      <td><input id="vei-name" value="${this.escapeAttr(v.name)}" style="width:110px"></td>
      <td><input id="vei-sku" value="${this.escapeAttr(v.sku)}" style="width:100px;font-family:monospace;font-size:12px"></td>
      <td colspan="2"><div style="display:flex;gap:4px"><input type="number" id="vei-price" value="${v.price??''}" placeholder="base" style="width:75px" step="0.01" title="Fixed price (blank = base + modifier)"><input type="number" id="vei-modifier" value="${v.price_modifier??0}" style="width:65px" step="0.01" placeholder="+0.00" title="Price modifier"></div></td>
      <td><input type="number" id="vei-cost" value="${v.cost??''}" style="width:70px" step="0.01" placeholder="—"></td>
      <td><input type="number" id="vei-stock" value="${v.stock_qty??0}" style="width:60px" min="0"></td>
      <td><select id="vei-active" style="width:56px"><option value="1" ${v.active?'selected':''}>Yes</option><option value="0" ${!v.active?'selected':''}>No</option></select></td>
      <td style="white-space:nowrap">
        <button class="btn btn-primary btn-sm" onclick="App._saveVarInline(${productId},${variationId})">Save</button>
        <button class="btn btn-secondary btn-sm" onclick="App.showVariationsPanel(${productId})">✕</button>
      </td>`;
  },

  async _saveVarInline(productId, variationId) {
    const priceVal = document.getElementById('vei-price')?.value;
    const costVal = document.getElementById('vei-cost')?.value;
    const existing = this._panelVariations?.find(x => x.id === variationId) || {};
    const data = {
      name: document.getElementById('vei-name')?.value?.trim(),
      sku: document.getElementById('vei-sku')?.value?.trim(),
      barcode: existing.barcode || null,
      attributes: JSON.parse(existing.attributes || '{}'),
      price: priceVal !== '' ? parseFloat(priceVal) : null,
      price_modifier: parseFloat(document.getElementById('vei-modifier')?.value) || 0,
      cost: costVal !== '' ? parseFloat(costVal) : null,
      stock_qty: parseInt(document.getElementById('vei-stock')?.value) || 0,
      min_stock: existing.min_stock || 5,
      active: parseInt(document.getElementById('vei-active')?.value),
    };
    try {
      await this.api('PUT', `/products/${productId}/variations/${variationId}`, data);
      await this.showVariationsPanel(productId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _deleteVariation(productId, variationId) {
    if (!confirm('Delete this variant? This cannot be undone.')) return;
    try {
      await this.api('DELETE', `/products/${productId}/variations/${variationId}`);
      this.showVariationsPanel(productId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  _varStockAdjust(productId, variationId, name, current) {
    this.showModal(`
      <div class="modal" style="max-width:360px">
        <div class="modal-header"><span class="modal-title">Adjust Stock: ${name}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="margin-bottom:12px;color:var(--text-muted)">Current stock: <strong>${current}</strong></p>
          <div class="form-group"><label>Adjustment (+/-)</label><input type="number" id="var-stock-adj" placeholder="e.g. +10 or -5"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App._applyVarStockAdjust(${productId},${variationId})">Apply</button>
        </div>
      </div>`);
  },

  async _applyVarStockAdjust(productId, variationId) {
    const adj = parseInt(document.getElementById('var-stock-adj')?.value) || 0;
    if (!adj) { this.alert('Enter an adjustment value', 'warning'); return; }
    try {
      await this.api('PATCH', `/products/${productId}/variations/${variationId}/stock`, { adjustment: adj });
      this.closeModal();
      this.alert('Stock adjusted');
      this.showVariationsPanel(productId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── POS Variation Picker ────────────────────────────────────────────────

  async showVariationPicker(product) {
    const [types, variations] = await Promise.all([
      this.api('GET', `/products/${product.id}/variation-types`),
      this.api('GET', `/products/${product.id}/variations`),
    ]);
    const activeVars = variations.filter(v => v.active);
    if (!activeVars.length) { this.alert('No active variants available', 'warning'); return; }
    this._pickerProduct = product;
    this._pickerVariations = activeVars;
    this._pickerTypes = types.map(t => ({ name: t.name, values: JSON.parse(t.attr_values||'[]') }));
    this._pickerSelection = {};
    this._pickerSelected = null;
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">${product.name}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div id="picker-attrs"></div>
          <div id="picker-info" style="display:none;margin-top:14px;padding:12px;border:1px solid var(--border);border-radius:6px">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Selected variant</div>
            <div id="picker-name" style="font-weight:600;margin-bottom:4px"></div>
            <div style="display:flex;gap:16px;font-size:13px">
              <span>Price: <strong id="picker-price"></strong></span>
              <span>Stock: <strong id="picker-stock"></strong></span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="btn-add-variant" onclick="App._addVariantToCart()" disabled>Add to Cart</button>
        </div>
      </div>`);
    this._renderPickerAttrs();
  },

  _renderPickerAttrs() {
    const container = document.getElementById('picker-attrs');
    if (!container) return;
    container.innerHTML = this._pickerTypes.map(type => `
      <div style="margin-bottom:12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">${type.name}</div>
        <div>${type.values.map(val => {
          const sel = this._pickerSelection[type.name] === val;
          const available = this._pickerVariations.some(v => {
            const a = JSON.parse(v.attributes || '{}');
            if (a[type.name] !== val) return false;
            for (const [k, s] of Object.entries(this._pickerSelection)) {
              if (k !== type.name && a[k] !== s) return false;
            }
            return v.stock_qty > 0;
          });
          return `<span class="var-chip ${sel ? 'active' : ''} ${!available && !sel ? 'oos' : ''}" onclick="App._pickAttr('${type.name}','${val}')">${val}</span>`;
        }).join('')}</div>
      </div>`).join('');
  },

  _pickAttr(typeName, value) {
    if (this._pickerSelection[typeName] === value) delete this._pickerSelection[typeName];
    else this._pickerSelection[typeName] = value;
    this._renderPickerAttrs();
    const allSel = this._pickerTypes.every(t => this._pickerSelection[t.name]);
    const info = document.getElementById('picker-info');
    const btn = document.getElementById('btn-add-variant');
    if (!allSel) { if (info) info.style.display = 'none'; if (btn) btn.disabled = true; this._pickerSelected = null; return; }
    const match = this._pickerVariations.find(v => {
      const a = JSON.parse(v.attributes || '{}');
      return this._pickerTypes.every(t => a[t.name] === this._pickerSelection[t.name]);
    });
    if (!match) { if (info) info.style.display = 'none'; if (btn) btn.disabled = true; this._pickerSelected = null; return; }
    const effPrice = match.price != null ? match.price : parseFloat((this._pickerProduct.price + (match.price_modifier || 0)).toFixed(2));
    document.getElementById('picker-name').textContent = match.name;
    document.getElementById('picker-price').textContent = this.fmt(effPrice);
    document.getElementById('picker-stock').textContent = match.stock_qty <= 0 ? 'Out of stock' : match.stock_qty;
    if (info) info.style.display = 'block';
    this._pickerSelected = match;
    this._pickerSelectedPrice = effPrice;
    if (btn) btn.disabled = match.stock_qty <= 0;
  },

  _addVariantToCart() {
    const variation = this._pickerSelected;
    const product = this._pickerProduct;
    if (!variation || !product) return;
    const existing = this.cart.find(i => i.product_id === product.id && i.variation_id === variation.id);
    const inCart = existing ? existing.quantity : 0;
    if (inCart >= variation.stock_qty) { this.alert('Not enough stock', 'warning'); return; }
    if (existing) { existing.quantity++; }
    else {
      this.cart.push({ product_id: product.id, category_id: product.category_id || null, variation_id: variation.id, name: product.name, variation_name: variation.name, price: this._pickerSelectedPrice, cost: variation.cost != null ? variation.cost : product.cost, tax_rate: product.tax_rate, quantity: 1, stock_qty: variation.stock_qty });
    }
    this.closeModal();
    this.renderCart();
    this._bundleUpsell(product.id);
  },

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
