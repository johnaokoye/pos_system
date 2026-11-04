// Product variations and the POS variation picker.
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

});
