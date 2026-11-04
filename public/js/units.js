// Units of measure: unit pickers, order-only units, the units manager.
Object.assign(App, {
  // ─── Unit choices and order-only units on POS, quote, PR and PO lines ────
  // Units of measure (lib/units.js) a product can be sold in ('sell': its
  // stock unit plus alternate units with a price) or ordered in ('buy': any
  // alternate unit). Each: { uom_id, name, label, factor, price, barcode,
  // allow_decimal, isBase }. label is null for a plain Each line.
  _unitChoices(p, purpose = 'sell') {
    if (!p) return [];
    const base = { uom_id: p.base_unit_id || null, name: p.base_unit_name || 'Each', label: p.base_unit_id ? p.base_unit_name : null, factor: 1, price: Number(p.price) || 0, barcode: p.barcode, allow_decimal: p.base_unit_decimal ? 1 : 0, isBase: true };
    if (p.is_service || p.is_rental || p.has_variations > 0) return [base];
    const alts = (p.units || []).filter(u => purpose === 'buy' || Number(u.price) > 0).map(u => ({ uom_id: u.unit_id, name: u.name, label: u.label, factor: Number(u.factor), price: Number(u.price) || 0, barcode: u.barcode, allow_decimal: u.allow_decimal ? 1 : 0, isBase: false }));
    return [base, ...alts];
  },

  // The unit a stored line (held ticket, quote) was in, from its uom_id.
  _unitChoiceFor(p, uomId, purpose = 'sell') {
    const choices = this._unitChoices(p, purpose);
    return choices.find(c => (c.uom_id ?? null) === (uomId ?? null)) || choices[0] || null;
  },

  _unitLineName(name, choice) { return choice?.label ? `${name} (${choice.label})` : name; },

  // Asks which unit to sell/order a product in when it has alternate units;
  // resolves the choice, or null if cancelled. Resolves the stock unit
  // straight away for a product with none.
  _pickUnit(p, purpose = 'sell') {
    const choices = this._unitChoices(p, purpose);
    if (choices.length < 2) return Promise.resolve(choices[0] || null);
    const stockAbbr = p.base_unit_abbr || p.base_unit_name || 'ea';
    return new Promise(resolve => {
      this._unitPickResolve = choice => { this._unitPickResolve = null; this.closeSecondaryModal(); resolve(choice); };
      this._unitPickChoices = choices;
      this.showSecondaryModal(`
        <div class="modal" style="max-width:420px">
          <div class="modal-header"><span class="modal-title">Unit of measure — ${this.escapeAttr(p.name)}</span><button class="modal-close" onclick="App._unitPickResolve && App._unitPickResolve(null)">✕</button></div>
          <div class="modal-body" style="display:flex;flex-direction:column;gap:8px">
            ${choices.map((c, i) => `<button type="button" class="btn btn-secondary unit-pick-btn" style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;font-size:15px;text-align:left" onclick="App._unitPickResolve(App._unitPickChoices[${i}])">
              <span><strong>${this.escapeAttr(c.label || c.name)}</strong>${c.isBase ? '' : ` <span style="font-size:12px;color:var(--text-muted)">= ${c.factor} ${this.escapeAttr(stockAbbr)}</span>`}</span>
              <span style="font-weight:700">${purpose === 'buy' ? `cost ${this.fmt((Number(p.cost) || 0) * c.factor)}` : this.fmt(c.price)}</span>
            </button>`).join('')}
          </div>
        </div>`);
      const overlay = document.getElementById('secondary-modal-overlay');
      overlay?.addEventListener('keydown', e => { if (e.key === 'Escape') this._unitPickResolve?.(null); });
      // Clicking off the box (or anything else closing it) counts as cancel.
      overlay?.addEventListener('click', e => { if (e.target === overlay) this._unitPickResolve?.(null); });
      setTimeout(() => overlay?.querySelector('.unit-pick-btn')?.focus(), 0);
    });
  },

  // A PR / PO line split for the Item and Unit columns, like
  // orderLineUnit() in lib/units.js: { name, unit } — the name without the
  // "(Case of 24)" it was saved with, and the unit it's ordered in.
  _orderLineUnit(line) {
    const name = String(line.product_name || '');
    if (line.item_type === 'service') return { name, unit: '—' };
    const per = Number(line.units_per) || 1;
    const m = line.purchase_unit ? name.match(/^(.*) \(([^()]*)\)$/) : null;
    if (m && m[2].toLowerCase().startsWith(String(line.purchase_unit).toLowerCase())) return { name: m[1], unit: m[2] };
    if (!line.purchase_unit) return { name, unit: 'Each' };
    return { name, unit: Number.isInteger(per) && per > 1 ? `${line.purchase_unit} of ${per}` : line.purchase_unit };
  },

  // Purchase request / PO line unit dropdown: the item's stock unit and
  // alternate units, plus "+ Add unit…" for anyone who raises PRs or POs
  // (POST /products/:id/units) — so they can order by the case or drum
  // without inventory edit rights.
  _canAddOrderUnit(p) {
    return !!p && !(p.is_service || p.is_rental || p.has_variations > 0)
      && ['inventory_edit', 'inventory_units', 'pr_create', 'purchasing_create'].some(k => this.can(k));
  },

  _orderUnitOptionsHtml(p, choice) {
    const choices = this._unitChoices(p, 'buy');
    const selected = choice && !choice.isBase ? String(choice.uom_id) : '';
    return choices.map(c => { const v = c.isBase ? '' : String(c.uom_id); return `<option value="${v}" ${v === selected ? 'selected' : ''}>${this.escapeAttr(c.label || c.name)}</option>`; }).join('')
      + (this._canAddOrderUnit(p) ? '<option value="__add">+ Add unit…</option>' : '');
  },

  // Asks for a new order unit for p (an existing unit or a brand-new one,
  // and how many stock units it holds), saves it on the item, updates
  // p.units in place and resolves the new _unitChoices() entry — or null.
  async _addOrderUnit(p) {
    const uoms = await this.api('GET', '/units').catch(() => []);
    const taken = new Set([p.base_unit_id, ...(p.units || []).map(u => u.unit_id)].filter(Boolean).map(Number));
    const avail = uoms.filter(u => u.active && !taken.has(Number(u.id)) && (p.base_unit_id || String(u.name).toLowerCase() !== 'each'));
    const stockName = p.base_unit_name || 'Each';
    const canNew = this.can('settings') || this.can('inventory_units') || this.can('pr_create') || this.can('purchasing_create');
    return new Promise(resolve => {
      this._orderUnitResolve = choice => { this._orderUnitResolve = null; this.closeSecondaryModal(); resolve(choice); };
      this.showSecondaryModal(`
        <div class="modal" style="max-width:440px">
          <div class="modal-header"><span class="modal-title">Add a unit — ${this.escapeAttr(p.name)}</span><button class="modal-close" onclick="App._orderUnitResolve && App._orderUnitResolve(null)">✕</button></div>
          <div class="modal-body">
            <div class="form-group"><label>Unit</label>
              <select id="ou-unit" onchange="document.getElementById('ou-new').style.display = this.value === '__new' ? '' : 'none'">
                ${avail.map(u => `<option value="${u.id}">${this.escapeAttr(u.name)}${u.abbreviation ? ` (${this.escapeAttr(u.abbreviation)})` : ''}</option>`).join('')}
                ${canNew ? `<option value="__new" ${avail.length ? '' : 'selected'}>+ New unit…</option>` : ''}
              </select>
            </div>
            <div id="ou-new" style="display:${avail.length || !canNew ? 'none' : ''};padding:10px;background:var(--bg);border-radius:6px;margin-bottom:12px">
              <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px">
                <div class="form-group" style="margin:0"><label>Name</label><input id="ou-name" placeholder="e.g. Drum"></div>
                <div class="form-group" style="margin:0"><label>Abbreviation</label><input id="ou-abbr" placeholder="e.g. dr"></div>
              </div>
              <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="ou-decimal" style="width:16px;height:16px"> Measured unit — allows part quantities (e.g. 2.5)</label>
            </div>
            <div class="form-group"><label>How many ${this.escapeAttr(stockName)} in one?</label><input id="ou-factor" type="number" min="0" step="any" placeholder="e.g. 24"></div>
            <div style="font-size:12px;color:var(--text-muted)">Saved on the item for ordering. Its selling price and barcode, if it's sold this way, are set on the product form.</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="App._orderUnitResolve(null)">Cancel</button>
            <button class="btn btn-primary" id="ou-save" onclick="App._saveOrderUnit(${p.id})">Add Unit</button>
          </div>
        </div>`);
      this._orderUnitProduct = p;
      const overlay = document.getElementById('secondary-modal-overlay');
      overlay?.addEventListener('keydown', e => { if (e.key === 'Escape') this._orderUnitResolve?.(null); });
      overlay?.addEventListener('click', e => { if (e.target === overlay) this._orderUnitResolve?.(null); });
      setTimeout(() => document.getElementById('ou-factor')?.focus(), 0);
    });
  },

  async _saveOrderUnit(productId) {
    const p = this._orderUnitProduct;
    if (!p || p.id !== productId) return;
    let unitId = document.getElementById('ou-unit').value;
    const factor = parseFloat(document.getElementById('ou-factor').value);
    if (!unitId) { this.alert('Choose a unit', 'error'); return; }
    if (!(factor > 0)) { this.alert(`Enter how many ${p.base_unit_name || 'Each'} are in one`, 'error'); return; }
    const btn = document.getElementById('ou-save');
    if (btn) btn.disabled = true;
    try {
      if (unitId === '__new') {
        const name = document.getElementById('ou-name').value.trim();
        if (!name) { this.alert('Name the new unit', 'error'); return; }
        const u = await this.api('POST', '/units', { name, abbreviation: document.getElementById('ou-abbr').value.trim(), allow_decimal: document.getElementById('ou-decimal').checked });
        unitId = u.id;
      }
      const r = await this.api('POST', `/products/${productId}/units`, { unit_id: Number(unitId), factor });
      p.units = r.units;
      // The same item may be loaded in other lists (POS, PO/PR pickers).
      for (const list of [this.allProducts, this._poProducts, this._prAllProducts]) {
        const other = (list || []).find(x => x.id === productId);
        if (other && other !== p) other.units = r.units;
      }
      this._orderUnitResolve?.(this._unitChoices(p, 'buy').find(c => !c.isBase && Number(c.uom_id) === Number(r.unit_id)) || null);
    } catch (e) { this.alert(e.message, 'error'); }
    finally { if (btn) btn.disabled = false; }
  },

  // ─── Units of measure manager ────────────────────────────────────
  // Units of measure list (routes/units.js). Opened over the product form
  // (fromForm) as a secondary modal so the form underneath isn't lost; its
  // unit dropdowns are refreshed when this closes.
  async showUnitsManager(fromForm = false) {
    const uoms = await this.api('GET', '/units');
    this._uoms = uoms;
    const canManage = this.can('inventory_units') || this.can('settings');
    const row = u => `<tr style="border-top:1px solid var(--border);${u.active ? '' : 'opacity:.55'}">
      <td style="padding:6px 10px"><input id="uom-name-${u.id}" value="${this.escapeAttr(u.name)}" style="width:100%" ${canManage ? '' : 'disabled'}></td>
      <td style="padding:6px 10px"><input id="uom-abbr-${u.id}" value="${this.escapeAttr(u.abbreviation || '')}" style="width:70px" ${canManage ? '' : 'disabled'}></td>
      <td style="padding:6px 10px;text-align:center"><input type="checkbox" id="uom-dec-${u.id}" ${u.allow_decimal ? 'checked' : ''} ${canManage ? '' : 'disabled'} style="width:auto"></td>
      <td style="padding:6px 10px;text-align:center"><input type="checkbox" id="uom-active-${u.id}" ${u.active ? 'checked' : ''} ${canManage ? '' : 'disabled'} style="width:auto"></td>
      <td style="padding:6px 10px;text-align:center;font-size:13px">${u.product_count}</td>
      <td style="padding:6px 10px;text-align:right;white-space:nowrap">${canManage ? `<button class="btn btn-secondary btn-sm" onclick="App._saveUnit(${u.id},${fromForm})">Save</button>${u.product_count ? '' : ` <button class="btn btn-danger btn-sm" onclick="App._deleteUnit(${u.id},${fromForm})">✕</button>`}` : ''}</td>
    </tr>`;
    const html = `
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">Units of Measure</span><button class="modal-close" onclick="App._closeUnitsManager(${fromForm})">✕</button></div>
        <div class="modal-body" style="padding:0">
          <p style="font-size:12px;color:var(--text-muted);margin:10px 16px">Units an item can be stocked, sold or ordered in. Tick <strong>Decimals</strong> for measures sold in part quantities (2.5 yards, 1.25 kg). An inactive unit stays on items already using it but isn't offered for new ones.</p>
          <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--bg-secondary)"><th style="padding:8px 10px;text-align:left;font-size:13px">Name</th><th style="padding:8px 10px;text-align:left;font-size:13px">Abbrev.</th><th style="padding:8px 10px;font-size:13px">Decimals</th><th style="padding:8px 10px;font-size:13px">Active</th><th style="padding:8px 10px;font-size:13px">Items</th><th></th></tr></thead>
            <tbody>${uoms.map(row).join('')}
              ${canManage ? `<tr style="border-top:2px solid var(--border)">
                <td style="padding:6px 10px"><input id="uom-name-new" placeholder="New unit, e.g. Yard" style="width:100%"></td>
                <td style="padding:6px 10px"><input id="uom-abbr-new" placeholder="yd" style="width:70px"></td>
                <td style="padding:6px 10px;text-align:center"><input type="checkbox" id="uom-dec-new" style="width:auto"></td>
                <td></td><td></td>
                <td style="padding:6px 10px;text-align:right"><button class="btn btn-primary btn-sm" onclick="App._saveUnit(null,${fromForm})">+ Add</button></td>
              </tr>` : ''}
            </tbody>
          </table></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App._closeUnitsManager(${fromForm})">Close</button></div>
      </div>`;
    if (fromForm) this.showSecondaryModal(html); else this.showModal(html);
  },

  async _saveUnit(id, fromForm) {
    const k = id || 'new';
    const data = {
      name: document.getElementById(`uom-name-${k}`).value.trim(),
      abbreviation: document.getElementById(`uom-abbr-${k}`).value.trim(),
      allow_decimal: document.getElementById(`uom-dec-${k}`).checked ? 1 : 0,
      active: id ? (document.getElementById(`uom-active-${k}`).checked ? 1 : 0) : 1,
    };
    if (!data.name) { this.alert('Enter the unit name', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/units/${id}`, data);
      else await this.api('POST', '/units', data);
      this.alert('Unit saved');
      this.showUnitsManager(fromForm);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _deleteUnit(id, fromForm) {
    try { await this.api('DELETE', `/units/${id}`); this.showUnitsManager(fromForm); }
    catch(e) { this.alert(e.message, 'error'); }
  },

  // Back on the product form: rebuild its unit dropdowns from the updated
  // list, keeping whatever was already chosen.
  _closeUnitsManager(fromForm) {
    if (!fromForm) { this.closeModal(); return; }
    this.closeSecondaryModal();
    const base = document.getElementById('pf-base-unit');
    if (!base) return;
    const uoms = (this._uoms || []).filter(u => u.active);
    const keep = base.value;
    base.innerHTML = `<option value="">Each</option>` + uoms.filter(u => u.name.toLowerCase() !== 'each').map(u => `<option value="${u.id}">${this.escapeAttr(u.name)}</option>`).join('');
    base.value = keep;
    document.querySelectorAll('#pf-unit-rows .pf-unit-id').forEach(sel => {
      const v = sel.value;
      sel.innerHTML = `<option value="">Unit…</option>` + uoms.map(u => `<option value="${u.id}">${this.escapeAttr(u.name)}</option>`).join('');
      sel.value = v;
    });
    this._pfRefreshUnitLabels();
  },
});
